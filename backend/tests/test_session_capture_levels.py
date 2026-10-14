# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The content level a session was captured at is what ingest applied, never
the mapping's current level, and never claimed for data stored before levels
were recorded."""

import copy
import json
import uuid

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, inspect, select, update

from app.database import get_db
from app.main import create_app
from app.models.agent_session import AgentSession, AgentSessionCapture
from app.schemas.beacon import REDACTIONS_KEY, for_content_level
from tests.test_agent_sessions import FIXTURE_EVENTS, ME, SESSIONS, record, upload
from tests.test_session_cost_migration import VERSIONS, _at_109, _columns, _load

PROMPT_TEXT = "Inspect synthetic fixture"


@pytest.fixture
async def device_client(db_session):
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app), base_url="http://test"
    ) as client:
        yield client


async def _enroll(client, workspace, board):
    installation = (
        await client.post(
            ME,
            json={
                "installation_id": str(uuid.uuid4()),
                "name": "Synthetic laptop",
                "platform": "linux-amd64",
            },
        )
    ).json()
    mapping = (
        await client.post(
            f"{ME}/{installation['installation_id']}/mappings",
            json={
                "workspace_id": str(workspace.id),
                "board_id": str(board.id),
                "root_path": "/synthetic/project",
            },
        )
    ).json()
    return installation, mapping


async def _set_level(client, installation, mapping, level):
    response = await client.patch(
        f"{ME}/{installation['installation_id']}/mappings/{mapping['id']}",
        json={"content_level": level},
    )
    assert response.status_code == 200, response.text


def _prompt(event_id):
    event = copy.deepcopy(FIXTURE_EVENTS[1])
    event["event"]["id"] = event_id
    return event


async def _capture_at(client, device_client, installation, mapping, level, events):
    await _set_level(client, installation, mapping, level)
    await upload(
        device_client,
        installation["device_token"],
        [record(events, mapping["id"])],
    )


async def _session(client):
    [item] = (await client.get(SESSIONS)).json()["items"]
    detail = await client.get(f"{SESSIONS}/{item['id']}")
    assert detail.status_code == 200
    return item, detail.json()


async def _events(client, session_id):
    response = await client.get(f"{SESSIONS}/{session_id}/events")
    assert response.status_code == 200
    return {item["event_id"]: item for item in response.json()["items"]}


async def test_metadata_capture_reports_metadata_and_sent_no_prompt(
    client, device_client, test_workspace, test_board
):
    installation, mapping = await _enroll(client, test_workspace, test_board)
    await _capture_at(
        client, device_client, installation, mapping, "metadata", [_prompt("p-1")]
    )

    listed, detail = await _session(client)
    assert listed["capture_levels"] == ["metadata"]
    assert detail["capture_levels"] == ["metadata"]
    event = (await _events(client, detail["id"]))["p-1"]
    assert event["capture_level"] == "metadata"
    assert PROMPT_TEXT not in json.dumps(event["data"])


async def test_level_changed_mid_session_reports_both_and_each_event_its_own(
    client, device_client, test_workspace, test_board
):
    installation, mapping = await _enroll(client, test_workspace, test_board)
    await _capture_at(
        client, device_client, installation, mapping, "metadata", [_prompt("p-meta")]
    )
    await _capture_at(
        client, device_client, installation, mapping, "standard", [_prompt("p-std")]
    )

    _, detail = await _session(client)
    assert detail["capture_levels"] == ["metadata", "standard"]
    events = await _events(client, detail["id"])
    # Privacy: the level each event reports is the one whose rules it was
    # stored under, whatever the mapping says today.
    assert events["p-meta"]["capture_level"] == "metadata"
    assert PROMPT_TEXT not in json.dumps(events["p-meta"]["data"])
    assert events["p-std"]["capture_level"] == "standard"
    assert events["p-std"]["data"]["prompt"]["text"].startswith(PROMPT_TEXT)


async def test_the_last_level_is_the_latest_capture(
    client, device_client, test_workspace, test_board
):
    installation, mapping = await _enroll(client, test_workspace, test_board)
    for index, level in enumerate(["metadata", "standard", "metadata"]):
        await _capture_at(
            client, device_client, installation, mapping, level, [_prompt(f"p-{index}")]
        )

    _, detail = await _session(client)
    assert detail["capture_levels"] == ["standard", "metadata"]


async def test_a_capture_that_stored_nothing_new_claims_no_level(
    client, device_client, test_workspace, test_board
):
    installation, mapping = await _enroll(client, test_workspace, test_board)
    await _capture_at(
        client, device_client, installation, mapping, "standard", [_prompt("p-1")]
    )
    # The same event again, now under full: deduplicated, so nothing was
    # stored at full and the session must not say it was.
    await _capture_at(
        client, device_client, installation, mapping, "full", [_prompt("p-1")]
    )

    _, detail = await _session(client)
    assert detail["capture_levels"] == ["standard"]
    assert (await _events(client, detail["id"]))["p-1"]["capture_level"] == "standard"


async def test_sessions_from_before_levels_were_recorded_claim_none(
    client, device_client, db_session, test_workspace, test_board
):
    installation, mapping = await _enroll(client, test_workspace, test_board)
    await _capture_at(
        client, device_client, installation, mapping, "standard", [_prompt("p-old")]
    )
    # What a session and its receipts look like when stored before 114.
    await db_session.execute(update(AgentSession).values(capture_levels=None))
    await db_session.execute(update(AgentSessionCapture).values(content_level=None))
    await db_session.flush()

    _, detail = await _session(client)
    assert detail["capture_levels"] == []
    assert (await _events(client, detail["id"]))["p-old"]["capture_level"] is None

    # Captured further after the upgrade: part of it still has no recorded
    # level, so the session keeps claiming none rather than "standard".
    await _capture_at(
        client, device_client, installation, mapping, "standard", [_prompt("p-new")]
    )
    _, detail = await _session(client)
    assert detail["capture_levels"] == []
    events = await _events(client, detail["id"])
    assert events["p-new"]["capture_level"] == "standard"
    assert events["p-old"]["capture_level"] is None
    stored = await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )
    assert stored.capture_levels is None


# --- withheld sizes ------------------------------------------------------------

DESCRIPTOR = {"bytes": 6400, "sha256": "a" * 64}
DIGEST = "[omitted 1400 bytes sha256:0123456789abcdef]"


def _tool_event(**members):
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    event.update(members)
    return event


def _redactions(event, level):
    return for_content_level(event, level)[REDACTIONS_KEY]


def test_standard_records_the_original_size_the_companion_declared():
    redactions = _redactions(
        _tool_event(
            tool={"name": "Bash", "output": DESCRIPTOR},
            command={"command": "ls", "stdout": "x" * 100},
        ),
        "standard",
    )
    # The companion already withheld tool.output; what Backplane removed is
    # its {bytes, sha256} descriptor, not 6.4 KB of output.
    assert redactions["tool.output"]["original_bytes"] == 6400
    assert redactions["command.stdout"]["original_bytes"] == 100


def test_metadata_records_the_original_size_behind_a_companion_digest():
    redactions = _redactions(_tool_event(prompt={"text": DIGEST}), "metadata")
    assert redactions["prompt"]["original_bytes"] == 1400


def test_otlp_placeholder_string_reports_its_declared_size():
    placeholder = '{"bytes":512,"sha256":"' + "b" * 64 + '"}'
    redactions = _redactions(
        _tool_event(tool={"name": "Bash", "output": placeholder}), "standard"
    )
    assert redactions["tool.output"]["original_bytes"] == 512


def test_size_is_unknown_when_withheld_content_mixes_placeholders_and_text():
    redactions = _redactions(
        _tool_event(output={"head": DIGEST, "tail": "plain text"}), "standard"
    )
    assert redactions["output"]["original_bytes"] is None
    # The fingerprint of what Backplane received is still recorded.
    assert redactions["output"]["bytes"] > 0


def test_full_withholds_nothing():
    stored = for_content_level(
        _tool_event(tool={"name": "Bash", "output": "everything"}), "full"
    )
    assert REDACTIONS_KEY not in stored


def test_a_cut_error_message_records_its_full_size():
    redactions = _redactions(
        _tool_event(error={"type": "ToolError", "message": "e" * 5000}), "standard"
    )
    assert redactions["error.message"]["original_bytes"] == 5000


def test_content_the_server_withheld_itself_keeps_its_received_size():
    redactions = _redactions(_tool_event(prompt={"text": "a real prompt"}), "metadata")
    assert redactions["prompt"]["original_bytes"] == redactions["prompt"]["bytes"]


# --- migration ---------------------------------------------------------------


def test_levels_migration_is_additive_leaves_old_rows_unclaimed_and_reverses(
    tmp_path,
):
    migration = _load(VERSIONS / "114_session_capture_levels.py")
    assert (migration.revision, migration.down_revision) == ("114", "113")
    engine = create_engine("sqlite:///" + str(tmp_path / "levels.db"))
    with engine.begin() as connection:
        _at_109(connection)
        connection.exec_driver_sql(
            "INSERT INTO agent_sessions (id, workspace_id, owner_id, installation_id, "
            "harness, native_session_id, started_at, last_event_at) VALUES "
            "('s', 'w', 'o', 'i', 'claude_code', 'n', '2026-09-25', '2026-09-25')"
        )
        connection.exec_driver_sql(
            "INSERT INTO agent_session_captures (id, installation_id, capture_id, "
            "session_id, content_hash, collection_method, event_count, captured_at, "
            "received_at) VALUES ('c', 'i', 'cap', 's', 'h', 'hook', 1, "
            "'2026-09-25', '2026-09-25')"
        )
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):  # up, down, and up again
            migration.upgrade()
            inspector = inspect(connection)
            assert _columns(inspector, "agent_sessions")["capture_levels"] is True
            assert _columns(inspector, "agent_session_captures")["content_level"]
            # Stored before levels were recorded: no level is claimed.
            assert (
                connection.exec_driver_sql(
                    "SELECT capture_levels FROM agent_sessions"
                ).scalar()
                is None
            )
            assert (
                connection.exec_driver_sql(
                    "SELECT content_level FROM agent_session_captures"
                ).scalar()
                is None
            )
            migration.downgrade()
            inspector = inspect(connection)
            assert "capture_levels" not in _columns(inspector, "agent_sessions")
            assert "content_level" not in _columns(inspector, "agent_session_captures")
    engine.dispose()
