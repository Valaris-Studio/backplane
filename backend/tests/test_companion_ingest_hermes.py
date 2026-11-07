# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The ingest qualified against Hermes Agent metadata records (harness
`hermes_agent`, collection method `plugin`, one projected Beacon event per
record), and the server's own strict projection of every Hermes event.

The event bodies are the adapter's golden fixtures, shared with its Go tests,
placed in synthetic records: capture ids, event ids and `captured_at` are
stand-ins, not the companion's own derivations.
"""

import copy
import hashlib
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select, text

from app.core.call_correlation import arguments_fingerprint
from app.core.harness import harness_display_name
from app.core.local_paths import place_event
from app.models.agent_session import (
    AgentSession,
    AgentSessionCapture,
    AgentSessionCaptureGeneration,
    AgentSessionContent,
    AgentSessionEvent,
    AgentSessionInvocation,
    SessionWorkLink,
)
from app.models.base import Base
from app.schemas.beacon import (
    MAX_KEPT_TEXT_BYTES,
    REDACTIONS_KEY,
    canonical_json,
    for_content_level,
)
from tests.rich_capture import GENERATION, declaration, enroll_rich
from tests.test_agent_sessions import links, session_id, work_under_invocation

ME = "/api/me/companion/installations"
INGEST = "/api/companion/ingest"
SESSIONS = "/api/workspaces/default/sessions"

HERMES_TESTDATA = (
    Path(__file__).resolve().parents[2] / "companion/internal/agent/hermes/testdata"
)
HERMES_AGENT = "hermes_agent"
HERMES_SESSION = "20260924_115958_a1b2c3"
HERMES_CALL_ID = "toolu_01AbCdEf"
# Plugin firing order; the fixtures' timestamps (= extra.observed_at) ascend.
HERMES_EVENTS = (
    "on_session_start",
    "post_tool_call",
    "post_approval_response",
    "on_session_finalize",
)
# Synthetic device paths; the export denylist refuses a macOS home path.
SYNTHETIC_HOME = "/home/dev"
HERMES_ROOT = f"{SYNTHETIC_HOME}/src/project"
OUTSIDE_ROOT = f"{SYNTHETIC_HOME}/elsewhere/tool"
HERMES_FOLDER = "project"
ENABLED_WITH_HERMES = ["claude_code", HERMES_AGENT]
BEACON_COMMIT = "b17031414618cf86f7aad2b485935e548e8a8e63"
# Stand-in for the companion's fixed UUIDv5 namespace: the server only needs
# the ids to be stable per observation, never to recompute them.
EVENT_ID_NAMESPACE = uuid.UUID("6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b")
SENTINEL = "HERMES_STAGE_C_SENTINEL"

# ProjectEvents' allowlist, which the server's strict projection of a
# `hermes_agent` event also keeps at every content level.
PROJECTED_LEAVES = frozenset(
    {
        "schema_version",
        "timestamp",
        "event.id",
        "event.action",
        "event.category",
        "event.kind",
        "event.fidelity",
        "harness.name",
        "harness.collection_method",
        "session.id",
        "session.working_directory",
        "tool.name",
        "mcp.server",
        "mcp.tool",
        "mcp.method.name",
        "gen_ai.operation.name",
        "gen_ai.tool.name",
        "gen_ai.tool.call.id",
        "approval.decision",
        "status",
    }
)


def fake_api_key() -> str:
    # Assembled at run time so the tree holds no credential-shaped literal.
    return "sk-" + "proj-" + "Q7x" * 12


def absolute_prefixes(path: str) -> set[str]:
    """`/home/dev/src` -> {`/home/dev`, `/home/dev/src`}: each ancestor below
    the first component, which alone is too generic to scan stored rows for."""
    parts = path.strip("/").split("/")
    return {"/" + "/".join(parts[:depth]) for depth in range(2, len(parts) + 1)}


def leaf_paths(value, prefix=()) -> set[str]:
    if isinstance(value, dict):
        return {
            path
            for key, child in value.items()
            for path in leaf_paths(child, (*prefix, key))
        }
    return {".".join(prefix)}


def capture_key(event_name: str, salt: str = "") -> str:
    return hashlib.sha256(f"hermes\x00{event_name}\x00{salt}".encode()).hexdigest()


def hermes_event(event_name: str, *, working_directory: str = HERMES_FOLDER) -> dict:
    """The companion's uplinked event for one plugin hook: the adapter's golden
    projection with its deterministic event id and placed working directory."""
    golden = (HERMES_TESTDATA / f"{event_name}.event.json").read_text()
    event = json.loads(golden.replace('"__CWD__"', json.dumps(working_directory)))
    event["event"]["id"] = str(
        uuid.uuid5(EVENT_ID_NAMESPACE, capture_key(event_name) + ":0")
    )
    # Setup guard: the golden fixture is the strict record, nothing else.
    assert leaf_paths(event) <= PROJECTED_LEAVES, leaf_paths(event) - PROJECTED_LEAVES
    assert "raw" not in event and "message" not in event and "repository" not in event
    return event


def hermes_record(events, mapping_id, *, capture_id=None, **overrides) -> dict:
    return {
        "capture_id": capture_id or uuid.uuid4().hex,
        "mapping_id": str(mapping_id),
        "harness": HERMES_AGENT,
        "harness_version": None,
        "collection_method": "plugin",
        "native_session_id": HERMES_SESSION,
        "captured_at": "2026-09-24T12:00:00Z",
        "beacon": {"commit": BEACON_COMMIT, "schema_version": "1.0"},
        "events": events,
        **overrides,
    }


def companion_records(mapping_id, *, working_directory=HERMES_FOLDER) -> list[dict]:
    """One record per hook, each named by its capture key as the daemon does."""
    return [
        hermes_record(
            [hermes_event(name, working_directory=working_directory)],
            mapping_id,
            capture_id=capture_key(name)[:32],
        )
        for name in HERMES_EVENTS
    ]


def naive_utc(iso: str) -> datetime:
    # The SQLite test database drops the offset of stored datetimes.
    return datetime.fromisoformat(iso).astimezone(timezone.utc).replace(tzinfo=None)


def as_naive(value: datetime) -> datetime:
    return (
        value.astimezone(timezone.utc).replace(tzinfo=None) if value.tzinfo else value
    )


def event_time(event_name: str) -> str:
    return hermes_event(event_name)["timestamp"]


# Where the companion has placed the root folder by the time it uplinks: its
# name at metadata, `.` (relative to the mapping root) above it.
COMPANION_ROOT_DIRECTORY = {"metadata": HERMES_FOLDER, "standard": ".", "full": "."}


@pytest.fixture
def enroll_hermes(client, test_workspace, test_board):
    async def enroll(*, content_level="metadata", enabled_agents=ENABLED_WITH_HERMES):
        installation = (
            await client.post(
                ME,
                json={
                    "installation_id": str(uuid.uuid4()),
                    "name": "Hermes laptop",
                    "platform": "darwin-arm64",
                },
            )
        ).json()
        installation_id = installation["installation_id"]
        mapping = await client.post(
            f"{ME}/{installation_id}/mappings",
            json={
                "workspace_id": str(test_workspace.id),
                "board_id": str(test_board.id),
                "root_path": HERMES_ROOT,
                "content_level": content_level,
            },
        )
        assert mapping.status_code in (200, 201), mapping.text
        if enabled_agents is not None:
            policy = await client.patch(
                f"{ME}/{installation_id}/policy",
                json={"enabled_agents": enabled_agents},
            )
            assert policy.status_code == 200, policy.text
        return {
            "installation_id": installation_id,
            "mapping_id": mapping.json()["id"],
            "headers": {"Authorization": "Bearer " + installation["device_token"]},
        }

    return enroll


async def ingest(device_client, device, records):
    response = await device_client.post(
        INGEST, json={"records": records}, headers=device["headers"]
    )
    assert response.status_code == 200, response.text
    return response.json()


async def count(db_session, model) -> int:
    return await db_session.scalar(select(func.count()).select_from(model))


async def only_session(db_session) -> AgentSession:
    return await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )


async def stored_events(db_session) -> dict[str, AgentSessionEvent]:
    rows = await db_session.scalars(
        select(AgentSessionEvent).execution_options(populate_existing=True)
    )
    return {row.event_id: row for row in rows}


async def receipts(db_session) -> dict[str, AgentSessionCapture]:
    rows = await db_session.scalars(
        select(AgentSessionCapture).execution_options(populate_existing=True)
    )
    return {row.capture_id: row for row in rows}


def summary(session: AgentSession) -> tuple:
    return (
        session.event_count,
        session.tool_call_count,
        session.error_count,
        session.prompt_count,
        session.status,
        as_naive(session.started_at),
        as_naive(session.last_event_at),
        as_naive(session.ended_at) if session.ended_at else None,
        session.cwd,
        session.repository,
        session.model,
        session.harness_version,
    )


async def stored_rows(
    db_session, *, prefixes: tuple[str, ...] | None = None
) -> list[str]:
    """Every stored row, as text, of every table (or those named with a prefix),
    read with raw SQL so no column type hides what is on disk."""
    await db_session.flush()
    rows = []
    for table in Base.metadata.sorted_tables:
        if prefixes and not table.name.startswith(prefixes):
            continue
        result = await db_session.execute(text(f'SELECT * FROM "{table.name}"'))
        rows.extend(f"{table.name}: {tuple(row)!r}" for row in result.all())
    return rows


SESSION_TABLES = ("agent_session", "session_")


# --- 1. admission ---------------------------------------------------------------


async def test_ingest_hermes_records_accepted_when_hermes_agent_enabled(
    device_client, enroll_hermes, db_session, test_board
):
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    result = await ingest(device_client, device, records)
    assert result["rejected"] == []
    assert result["acknowledged"] == [item["capture_id"] for item in records]
    session = await only_session(db_session)
    assert session.harness == HERMES_AGENT
    assert session.native_session_id == HERMES_SESSION
    assert str(session.mapping_id) == device["mapping_id"]
    assert session.board_id == test_board.id
    assert session.event_count == len(HERMES_EVENTS)
    assert session.tool_call_count == 1
    assert session.status == "ended"
    assert {row.collection_method for row in (await receipts(db_session)).values()} == {
        "plugin"
    }


@pytest.mark.parametrize(
    "enabled_agents",
    [
        pytest.param(None, id="new-installation-default"),
        pytest.param(["claude_code", "codex_cli", "pi_cli"], id="known-harnesses"),
        pytest.param(["hermes"], id="hook-alias-is-not-the-harness"),
        pytest.param(["hermes_cli"], id="provisional-id"),
        pytest.param([], id="nothing-enabled"),
    ],
)
async def test_ingest_hermes_records_rejected_as_agent_disabled(
    client, device_client, enroll_hermes, db_session, enabled_agents
):
    device = await enroll_hermes(enabled_agents=enabled_agents)
    if enabled_agents is None:
        policy = (await client.get(f"{ME}/{device['installation_id']}/policy")).json()
        assert (
            HERMES_AGENT not in policy["enabled_agents"]
        ), "setup: this case covers installations that never enabled Hermes"
    records = companion_records(device["mapping_id"])
    result = await ingest(device_client, device, records)
    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": item["capture_id"], "reason": "agent_disabled"}
        for item in records
    ]
    assert await count(db_session, AgentSession) == 0
    assert await count(db_session, AgentSessionEvent) == 0
    assert await count(db_session, AgentSessionCapture) == 0


# --- 2-4. both dedupe layers ------------------------------------------------------


async def test_ingest_hermes_identical_replay_is_received_once(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    await ingest(device_client, device, records)
    before_session = summary(await only_session(db_session))
    before_events = {
        event_id: (row.event, as_naive(row.received_at), row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    }
    before_receipts = {
        capture_id: (row.content_hash, as_naive(row.received_at))
        for capture_id, row in (await receipts(db_session)).items()
    }

    # A lost ack retransmits the exact queued bytes, alone and twice over.
    replayed = await ingest(device_client, device, copy.deepcopy(records))
    doubled = await ingest(device_client, device, [*records, *records])

    assert replayed["rejected"] == [] and doubled["rejected"] == []
    assert replayed["acknowledged"] == [item["capture_id"] for item in records]
    assert doubled["acknowledged"] == [item["capture_id"] for item in records] * 2
    assert await count(db_session, AgentSession) == 1
    assert summary(await only_session(db_session)) == before_session
    # Recognized at the capture layer: no second receipt, nothing re-stored.
    assert {
        capture_id: (row.content_hash, as_naive(row.received_at))
        for capture_id, row in (await receipts(db_session)).items()
    } == before_receipts
    assert {
        event_id: (row.event, as_naive(row.received_at), row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    } == before_events


def _status_error(record):
    record["events"][0]["status"] = "error"


def _later_capture(record):
    record["captured_at"] = "2026-09-24T12:05:00Z"


def _new_event_id(record):
    record["events"][0]["event"]["id"] = str(uuid.uuid4())


def _other_tool(record):
    record["events"][0]["tool"]["name"] = "mcp__backplane__delete_card"
    record["events"][0]["mcp"]["tool"] = "delete_card"


@pytest.mark.parametrize(
    "change", [_status_error, _later_capture, _new_event_id, _other_tool]
)
async def test_ingest_hermes_same_capture_id_with_other_bytes_conflicts_and_keeps_original(
    device_client, enroll_hermes, db_session, change
):
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    tool_record = records[HERMES_EVENTS.index("post_tool_call")]
    await ingest(device_client, device, records)
    before_session = summary(await only_session(db_session))
    before_events = {
        event_id: row.event
        for event_id, row in (await stored_events(db_session)).items()
    }
    before_hash = (await receipts(db_session))[tool_record["capture_id"]].content_hash

    changed = copy.deepcopy(tool_record)
    change(changed)
    fresh = hermes_record(
        [hermes_event("post_tool_call")],
        device["mapping_id"],
        capture_id=uuid.uuid4().hex,
    )
    fresh["events"][0]["event"]["id"] = str(uuid.uuid4())
    fresh["events"][0]["gen_ai"]["tool"]["call"]["id"] = "toolu_02Fresh"
    result = await ingest(device_client, device, [changed, fresh])

    assert result["rejected"] == [
        {"capture_id": tool_record["capture_id"], "reason": "conflict"}
    ]
    assert result["acknowledged"] == [fresh["capture_id"]]
    after_events = {
        event_id: row.event
        for event_id, row in (await stored_events(db_session)).items()
    }
    # The original copy is untouched; only the unrelated fresh record was added.
    assert {key: after_events[key] for key in before_events} == before_events
    assert set(after_events) - set(before_events) == {fresh["events"][0]["event"]["id"]}
    receipt = (await receipts(db_session))[tool_record["capture_id"]]
    assert receipt.content_hash == before_hash
    session = await only_session(db_session)
    assert session.capture_gaps == 1
    event_count, tool_call_count, *unchanged = summary(session)
    # The fresh record adds one event and one call; nothing else moves.
    assert (event_count, tool_call_count) == (
        before_session[0] + 1,
        before_session[1] + 1,
    )
    assert unchanged == list(before_session[2:])


def _changed_content(event):
    event["status"] = "error"
    event["tool"]["name"] = "mcp__backplane__delete_card"
    event["mcp"]["tool"] = "delete_card"
    event["gen_ai"]["tool"]["name"] = "delete_card"
    event["timestamp"] = "2026-09-24T12:30:00.000000Z"


@pytest.mark.parametrize("raise_level_to_full", [False, True])
async def test_ingest_hermes_event_id_reused_in_new_capture_keeps_first_copy(
    client, device_client, enroll_hermes, db_session, raise_level_to_full
):
    # A strict harness's event id already stored under another capture
    # refuses the whole record as a conflict, counted as a gap.
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    await ingest(device_client, device, records)
    original = hermes_event("post_tool_call")
    event_id = original["event"]["id"]
    before_row = (await stored_events(db_session))[event_id]
    before = (
        before_row.event,
        before_row.capture_id,
        before_row.tool_name,
        before_row.mcp_tool,
        before_row.outcome,
        as_naive(before_row.occurred_at),
    )
    before_session = summary(await only_session(db_session))
    if raise_level_to_full:
        await client.patch(
            f"{ME}/{device['installation_id']}/mappings/{device['mapping_id']}",
            json={"content_level": "full"},
        )

    reused = copy.deepcopy(original)
    _changed_content(reused)
    if raise_level_to_full:
        reused["raw"] = {"hermes": {"args": {"card_id": SENTINEL}}}
    later = hermes_record([reused], device["mapping_id"], capture_id=uuid.uuid4().hex)
    result = await ingest(device_client, device, [later])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": later["capture_id"], "reason": "conflict"}
    ]
    assert later["capture_id"] not in await receipts(db_session)
    assert (await only_session(db_session)).capture_gaps == 1
    row = (await stored_events(db_session))[event_id]
    assert (
        row.event,
        row.capture_id,
        row.tool_name,
        row.mcp_tool,
        row.outcome,
        as_naive(row.occurred_at),
    ) == before
    assert await count(db_session, AgentSessionEvent) == len(HERMES_EVENTS)
    assert summary(await only_session(db_session)) == before_session
    assert SENTINEL not in "\n".join(await stored_rows(db_session))


async def test_ingest_hermes_event_id_repeated_within_one_record_is_refused_as_conflict(
    device_client, enroll_hermes, db_session
):
    # Neither copy wins silently: the record is refused whole.
    device = await enroll_hermes()
    first = hermes_event("post_tool_call")
    second = copy.deepcopy(first)
    _changed_content(second)
    record = hermes_record([first, second], device["mapping_id"])
    result = await ingest(device_client, device, [record])
    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "conflict"}
    ]
    assert await count(db_session, AgentSession) == 0
    assert await count(db_session, AgentSessionEvent) == 0
    assert await count(db_session, AgentSessionCapture) == 0


# --- 5. strict record: nothing for the server to fingerprint ----------------------------


@pytest.mark.parametrize("event_name", HERMES_EVENTS)
@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_hermes_strict_record_stores_no_redactions(
    device_client, enroll_hermes, db_session, content_level, event_name
):
    device = await enroll_hermes(content_level=content_level)
    uploaded = hermes_event(
        event_name, working_directory=COMPANION_ROOT_DIRECTORY[content_level]
    )
    result = await ingest(
        device_client, device, [hermes_record([uploaded], device["mapping_id"])]
    )
    assert result["rejected"] == []
    [row] = (await stored_events(db_session)).values()
    stored = row.event
    redactions = stored.get(REDACTIONS_KEY, {})
    assert REDACTIONS_KEY not in stored, (
        f"{event_name} at {content_level}: the server fingerprinted "
        f"{sorted(redactions)} of a strict Hermes record"
    )
    assert "raw" not in stored and "message" not in stored
    assert leaf_paths(stored) <= PROJECTED_LEAVES
    expected = copy.deepcopy(uploaded)
    expected["session"]["working_directory"] = HERMES_FOLDER
    assert stored == expected


# --- 6. the server's own validation of a record that smuggles content -------------------


def smuggled_additions(event_name: str) -> dict:
    """Dotted path -> value a faulty or hostile companion might add to a Hermes
    event: bodies and a local checkout path, generic metadata leaves outside the
    Hermes allowlist, unknown members of allowlisted objects, and an object
    where the allowlist names a leaf."""
    secret = fake_api_key()
    additions = {
        "raw": {
            "hermes": {
                "args": {"query": f"{SENTINEL}-raw-args", "api_key": secret},
                "result": f"{SENTINEL}-raw-result",
                "user_message": f"{SENTINEL}-raw-user-message",
                "conversation_history": [
                    {"role": "user", "content": f"{SENTINEL}-history"}
                ],
                "cwd": HERMES_ROOT,
            }
        },
        "message": f"{SENTINEL}-message {secret}",
        "repository": HERMES_ROOT,
        "prompt": {"text": f"{SENTINEL}-prompt"},
        "error": {"message": f"{SENTINEL}-error token={secret}"},
        "tool.input": {
            "command": f"echo {SENTINEL}-tool-input > {HERMES_ROOT}/notes.txt"
        },
        "gen_ai.tool.call.arguments": {
            "card_id": f"{SENTINEL}-arguments",
            "token": secret,
        },
        # The generic metadata tree keeps these; the Hermes allowlist does not.
        "vendor": "beacon",
        "product": "endpoint-agent",
        "severity": "info",
        "sequence": 7,
        "endpoint.os": "darwin",
        "trace.id": f"session:hermes:{HERMES_SESSION}",
        "harness.version": "0.22.4",
        "gen_ai.usage.input_tokens": 12,
        "event.reason": f"{SENTINEL}-event-reason",
        "session.title": f"{SENTINEL}-session-title",
        "mcp.arguments": f"{SENTINEL}-mcp-arguments",
        "approval.reason": f"{SENTINEL}-approval-reason",
    }
    if event_name != "post_tool_call":
        additions["status"] = {"text": f"{SENTINEL}-status-object"}
    return additions


def set_path(event: dict, dotted: str, value) -> None:
    *parents, leaf = dotted.split(".")
    node = event
    for name in parents:
        node = node.setdefault(name, {})
    node[leaf] = value


def smuggled(event_name: str, *, working_directory: str = HERMES_FOLDER) -> dict:
    event = hermes_event(event_name, working_directory=working_directory)
    for path, value in smuggled_additions(event_name).items():
        set_path(event, path, copy.deepcopy(value))
    return event


# What the generic content levels fingerprint of a smuggled event.
SMUGGLED_PATHS = {
    "raw",
    "message",
    "prompt",
    "error",
    "tool.input",
    "gen_ai.tool.call.arguments",
}

# The stored event and the search index built from it.
EVENT_TABLES = ("agent_session_events", "session_search_")


def leaves(value, prefix=()) -> dict[str, object]:
    """Dotted path -> scalar; empty objects name nothing."""
    if isinstance(value, dict):
        return {
            path: leaf
            for key, child in value.items()
            for path, leaf in leaves(child, (*prefix, key)).items()
        }
    return {".".join(prefix): value}


def digest_of(value) -> str:
    # The server's fingerprint encoding: text as is, anything else canonical JSON.
    encoded = value if isinstance(value, str) else canonical_json(value)
    return hashlib.sha256(encoded.encode()).hexdigest()


def smuggled_digests() -> set[str]:
    """The sha256 of every smuggled value, as uploaded and as the ingest places
    it (a value holding the mapping root is fingerprinted after placement)."""
    values = [
        value for name in HERMES_EVENTS for value in smuggled_additions(name).values()
    ]
    return {digest_of(value) for value in values} | {
        digest_of(place_event(value, [HERMES_ROOT])) for value in values
    }


def test_strict_metadata_harnesses_names_only_hermes_agent():
    from app.core import harness

    assert getattr(harness, "STRICT_METADATA_HARNESSES", None) == frozenset(
        {HERMES_AGENT}
    )


async def test_ingest_hermes_smuggled_content_at_metadata_keeps_no_bodies(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes(content_level="metadata")
    records = [
        hermes_record(
            [smuggled(name)], device["mapping_id"], capture_id=capture_key(name)[:32]
        )
        for name in HERMES_EVENTS
    ]
    result = await ingest(device_client, device, records)
    assert result["rejected"] == []

    rows = await stored_rows(db_session)
    for leaked in (SENTINEL, fake_api_key()):
        offending = [row for row in rows if leaked in row]
        assert offending == [], f"{leaked!r} stored in {offending[:3]}"
    session_rows = await stored_rows(db_session, prefixes=SESSION_TABLES)
    assert [row for row in session_rows if HERMES_ROOT in row] == []

    for row in (await stored_events(db_session)).values():
        stored = row.event
        assert "raw" not in stored and "message" not in stored
        assert "repository" not in stored
        # Dropped, never fingerprinted: no server redaction stands in.
        assert REDACTIONS_KEY not in stored, sorted(stored[REDACTIONS_KEY])
        assert leaf_paths(stored) <= PROJECTED_LEAVES
    session = await only_session(db_session)
    assert session.title is None
    assert session.repository is None
    assert session.cwd == HERMES_FOLDER


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_hermes_smuggled_content_stores_only_the_strict_projection(
    device_client, enroll_hermes, db_session, content_level
):
    device = await enroll_hermes(content_level=content_level)
    placed = COMPANION_ROOT_DIRECTORY[content_level]
    records = [
        hermes_record(
            [smuggled(name, working_directory=placed)],
            device["mapping_id"],
            capture_id=capture_key(name)[:32],
        )
        for name in HERMES_EVENTS
    ]
    result = await ingest(device_client, device, records)
    assert result["rejected"] == []

    stored = await stored_events(db_session)
    assert len(stored) == len(HERMES_EVENTS)
    for name in HERMES_EVENTS:
        golden = hermes_event(name)
        event = stored[golden["event"]["id"]].event
        assert (
            REDACTIONS_KEY not in event
        ), f"{name} at {content_level}: fingerprinted {sorted(event[REDACTIONS_KEY])}"
        # Every allowlisted leaf kept as uploaded, nothing else.
        assert leaves(event) == leaves(golden), f"{name} at {content_level}"

    digests = smuggled_digests()
    fingerprinted = [
        row
        for row in await stored_rows(db_session)
        if any(digest in row for digest in digests)
    ]
    assert (
        fingerprinted == []
    ), f"a smuggled value's sha256 is stored: {fingerprinted[:2]}"
    event_rows = await stored_rows(db_session, prefixes=EVENT_TABLES)
    for leaked in (SENTINEL, fake_api_key()):
        offending = [row for row in event_rows if leaked in row]
        assert offending == [], f"{leaked!r} stored in {offending[:2]}"


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_hermes_strict_projection_drops_long_allowlisted_text(
    device_client, enroll_hermes, db_session, content_level
):
    # Past its value pattern a leaf is dropped, never kept capped.
    device = await enroll_hermes(content_level=content_level)
    long_status = "ok" + "x" * (3 * MAX_KEPT_TEXT_BYTES)
    long_server = "backplane" + "s" * (3 * MAX_KEPT_TEXT_BYTES)
    uploaded = hermes_event(
        "post_tool_call", working_directory=COMPANION_ROOT_DIRECTORY[content_level]
    )
    uploaded["status"] = long_status
    uploaded["mcp"]["server"] = long_server
    result = await ingest(
        device_client, device, [hermes_record([uploaded], device["mapping_id"])]
    )
    assert result["rejected"] == []

    [row] = (await stored_events(db_session)).values()
    stored = row.event
    assert REDACTIONS_KEY not in stored
    expected = leaves(hermes_event("post_tool_call"))
    del expected["status"], expected["mcp.server"]
    assert leaves(stored) == expected
    capped = for_content_level(uploaded, "metadata")
    for dropped in (
        long_status,
        long_server,
        capped["status"],
        capped["mcp"]["server"],
    ):
        offending = [
            row
            for row in await stored_rows(db_session)
            if dropped[:64] in row or digest_of(dropped) in row
        ]
        assert (
            offending == []
        ), f"a dropped leaf or its sha256 is stored: {offending[:2]}"


CLAUDE_SESSION = "claude-session-0001"


def claude_code_record(event: dict, mapping_id) -> dict:
    event["harness"].update(name="claude_code", collection_method="hook")
    event["session"]["id"] = CLAUDE_SESSION
    return hermes_record(
        [event],
        mapping_id,
        harness="claude_code",
        collection_method="hook",
        native_session_id=CLAUDE_SESSION,
    )


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_claude_code_smuggled_content_keeps_its_content_level(
    device_client, enroll_hermes, db_session, content_level
):
    """Control: the strict projection is Hermes-only; the same smuggled event
    from another harness keeps the generic content-level behavior."""
    device = await enroll_hermes(content_level=content_level)
    event = smuggled(
        "post_tool_call", working_directory=COMPANION_ROOT_DIRECTORY[content_level]
    )
    result = await ingest(
        device_client, device, [claude_code_record(event, device["mapping_id"])]
    )
    assert result["rejected"] == []

    [row] = (await stored_events(db_session)).values()
    stored = row.event
    if content_level == "metadata":
        assert SMUGGLED_PATHS <= set(stored[REDACTIONS_KEY])
        for fingerprint in stored[REDACTIONS_KEY].values():
            assert set(fingerprint) == {"sha256", "bytes", "original_bytes"}
        assert (stored["vendor"], stored["sequence"], stored["harness"]["version"]) == (
            "beacon",
            7,
            "0.22.4",
        )
    elif content_level == "standard":
        assert "raw" not in stored and "raw" in stored[REDACTIONS_KEY]
        assert stored["prompt"] == {"text": f"{SENTINEL}-prompt"}
        assert "message" in stored and stored["vendor"] == "beacon"
    else:
        assert REDACTIONS_KEY not in stored
        assert stored["raw"]["hermes"]["result"] == f"{SENTINEL}-raw-result"
        assert stored["prompt"] == {"text": f"{SENTINEL}-prompt"}
        assert stored["event"]["reason"] == f"{SENTINEL}-event-reason"


# --- 7. order of arrival ------------------------------------------------------------------


async def test_ingest_hermes_out_of_order_keeps_latest_session_facts(
    client, device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    # The person cd'ed into a subfolder before Hermes finalized the session.
    by_name = {
        name: hermes_record(
            [
                hermes_event(
                    name,
                    working_directory="api"
                    if name == "on_session_finalize"
                    else HERMES_FOLDER,
                )
            ],
            device["mapping_id"],
            capture_id=capture_key(name)[:32],
        )
        for name in HERMES_EVENTS
    }
    for name in reversed(HERMES_EVENTS):
        result = await ingest(device_client, device, [by_name[name]])
        assert result["rejected"] == [], name

    session = await only_session(db_session)
    finalized_at = naive_utc(event_time("on_session_finalize"))
    assert session.cwd == "api"
    assert session.status == "ended"
    assert as_naive(session.ended_at) == finalized_at
    assert as_naive(session.last_event_at) == finalized_at
    assert as_naive(session.started_at) == naive_utc(event_time("on_session_start"))
    assert session.event_count == len(HERMES_EVENTS)
    listed = (await client.get(SESSIONS)).json()["items"]
    events = (await client.get(f"{SESSIONS}/{listed[0]['id']}/events")).json()["items"]
    assert [item["action"] for item in events] == [
        hermes_event(name)["event"]["action"] for name in HERMES_EVENTS
    ]


# --- 8. display ----------------------------------------------------------------------------


def test_harness_display_name_hermes_agent():
    assert harness_display_name(HERMES_AGENT) == "Hermes Agent"


async def test_get_sessions_hermes_returns_harness_id_and_display_name(
    client, device_client, enroll_hermes
):
    device = await enroll_hermes()
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    [listed] = (await client.get(SESSIONS)).json()["items"]
    assert listed["harness"] == HERMES_AGENT
    assert listed["harness_display_name"] == "Hermes Agent"
    detail = (await client.get(f"{SESSIONS}/{listed['id']}")).json()
    assert detail["harness"] == HERMES_AGENT
    assert detail["harness_display_name"] == "Hermes Agent"
    assert detail["native_session_id"] == HERMES_SESSION


# --- 9. work links ----------------------------------------------------------------------------


def hermes_invocation(invocation_id, card, **values):
    called_at = datetime.fromisoformat(event_time("post_tool_call"))
    return {
        "id": str(invocation_id),
        "tool_name": "get_card",
        "workspace_slug": "default",
        "status": "completed",
        "started_at": (called_at - timedelta(milliseconds=400)).isoformat(),
        "completed_at": (called_at - timedelta(milliseconds=100)).isoformat(),
        "duration_seconds": 0.3,
        "harness": None,
        "native_call_id": None,
        # The Python MCP SDK's default clientInfo: Hermes passes none.
        "client_name": "mcp",
        "client_version": "2.3.0",
        "arguments_fingerprint": arguments_fingerprint(
            {"workspace_slug": "default", "card_id": str(card.id)}
        ),
        **values,
    }


async def hermes_call_with_work(client, board, card, **values):
    invocation_id = uuid.uuid4()
    await work_under_invocation(client, board, card, invocation_id)
    response = await client.post(
        "/api/me/mcp-invocations", json=hermes_invocation(invocation_id, card, **values)
    )
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("invocation_first", [False, True])
@pytest.mark.parametrize(
    "attribution",
    [
        pytest.param({}, id="unattributed"),
        pytest.param({"harness": HERMES_AGENT}, id="attributed-to-hermes"),
        pytest.param(
            {"harness": HERMES_AGENT, "arguments_fingerprint": None},
            id="no-fingerprint",
        ),
    ],
)
async def test_link_hermes_session_without_exact_call_id_creates_no_work_link(
    client,
    device_client,
    enroll_hermes,
    db_session,
    test_board,
    test_card,
    invocation_first,
    attribution,
):
    device = await enroll_hermes()
    if invocation_first:
        await hermes_call_with_work(client, test_board, test_card, **attribution)
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    if not invocation_first:
        await hermes_call_with_work(client, test_board, test_card, **attribution)

    assert await links(client, await session_id(client)) == {}
    assert await count(db_session, SessionWorkLink) == 0
    assert await count(db_session, AgentSessionInvocation) == 0
    tool_row = (await stored_events(db_session))[
        hermes_event("post_tool_call")["event"]["id"]
    ]
    assert tool_row.native_tool_call_id == HERMES_CALL_ID
    # No correlation family for Hermes: nothing to match a call by its shape.
    assert tool_row.tool_call_signature is None


async def test_link_hermes_session_with_exact_call_id_links_control(
    client, device_client, enroll_hermes, test_board, test_card
):
    """Control for the test above: the same call does link once the harness's
    own call id is on both sides, so the absence there is the missing id."""
    device = await enroll_hermes()
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    await hermes_call_with_work(
        client,
        test_board,
        test_card,
        harness=HERMES_AGENT,
        native_call_id=HERMES_CALL_ID,
        arguments_fingerprint=None,
    )
    found = await links(client, await session_id(client))
    assert found and {item["provenance"] for item in found.values()} == {"exact"}


# --- 10. no device path -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "content_level,working_directory,expected_cwd",
    [
        ("metadata", HERMES_FOLDER, HERMES_FOLDER),
        ("standard", ".", HERMES_FOLDER),
        ("full", ".", HERMES_FOLDER),
        # A companion that failed to place the path: the server places it.
        ("metadata", f"{HERMES_ROOT}/api", "api"),
        ("standard", f"{HERMES_ROOT}/api", f"{HERMES_FOLDER}/api"),
        ("full", f"{HERMES_ROOT}/api", f"{HERMES_FOLDER}/api"),
        # Outside the root: dropped at metadata, its folder's name above it.
        ("metadata", OUTSIDE_ROOT, None),
        ("full", OUTSIDE_ROOT, "tool"),
    ],
)
async def test_ingest_hermes_stores_no_absolute_path(
    client,
    device_client,
    enroll_hermes,
    db_session,
    content_level,
    working_directory,
    expected_cwd,
):
    device = await enroll_hermes(content_level=content_level)
    result = await ingest(
        device_client,
        device,
        companion_records(device["mapping_id"], working_directory=working_directory),
    )
    assert result["rejected"] == []
    session = await only_session(db_session)
    assert session.cwd == expected_cwd
    assert session.repository is None
    for row in (await stored_events(db_session)).values():
        assert row.event["session"].get("working_directory") == expected_cwd
    device_paths = absolute_prefixes(HERMES_ROOT) | absolute_prefixes(OUTSIDE_ROOT)
    # Non-vacuity: the mapping row does hold the device root, so the scan
    # below would see a device path wherever one was stored.
    assert any(HERMES_ROOT in row for row in await stored_rows(db_session))
    offending = [
        (path, row)
        for row in await stored_rows(db_session, prefixes=SESSION_TABLES)
        for path in device_paths
        if path in row
    ]
    assert offending == []
    [listed] = (await client.get(SESSIONS)).json()["items"]
    assert listed["cwd"] == expected_cwd


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_hermes_session_facts_come_only_from_the_strict_projection(
    device_client, enroll_hermes, db_session, content_level
):
    # The session row is built from the parsed events, not the stored copies: a
    # smuggled prompt, model or token count must not reach it either.
    device = await enroll_hermes(content_level=content_level)
    placed = COMPANION_ROOT_DIRECTORY[content_level]
    uploaded = []
    for name in HERMES_EVENTS:
        event = smuggled(name, working_directory=placed)
        set_path(event, "prompt.text", f"{SENTINEL}-session-prompt")
        set_path(event, "gen_ai.request.model", f"{SENTINEL}-model")
        set_path(event, "git.branch", f"{SENTINEL}-branch")
        uploaded.append(
            hermes_record(
                [event], device["mapping_id"], capture_id=capture_key(name)[:32]
            )
        )
    result = await ingest(device_client, device, uploaded)
    assert result["rejected"] == []

    session = await only_session(db_session)
    assert session.title is None
    assert session.model is None
    assert session.branch is None
    assert session.input_tokens == 0
    for leaked in (SENTINEL, fake_api_key()):
        offending = [row for row in await stored_rows(db_session) if leaked in row]
        assert offending == [], f"{leaked!r} stored in {offending[:2]}"


# --- 11. a strict record declares no contents --------------------------------------------


def smuggled_body() -> bytes:
    # Built at run time: a prompt body a faulty or hostile companion might declare.
    return f"{SENTINEL} prompt: deploy with {fake_api_key()}".encode()


def smuggled_declaration() -> dict:
    return declaration(
        smuggled_body(),
        channel="prompt",
        role="user",
        display_path=f"{SENTINEL.lower()}-plan.md",
    )


def with_contents(record: dict) -> dict:
    record["contents"] = [smuggled_declaration()]
    record["capture_generation"] = dict(GENERATION)
    return record


async def assert_no_declaration_kept(db_session) -> None:
    assert await count(db_session, AgentSessionContent) == 0
    assert await count(db_session, AgentSessionCaptureGeneration) == 0
    digest = hashlib.sha256(smuggled_body()).hexdigest()
    rows = await stored_rows(db_session)
    for leaked in (SENTINEL, SENTINEL.lower(), fake_api_key(), digest):
        offending = [row for row in rows if leaked in row]
        assert offending == [], f"{leaked!r} stored in {offending[:2]}"


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_hermes_record_declaring_contents_is_rejected_invalid(
    device_client, enroll_hermes, db_session, content_level
):
    device = await enroll_hermes(content_level=content_level)
    record = with_contents(
        hermes_record(
            [
                hermes_event(
                    "post_tool_call",
                    working_directory=COMPANION_ROOT_DIRECTORY[content_level],
                )
            ],
            device["mapping_id"],
        )
    )
    result = await ingest(device_client, device, [record])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert (
        result["contents"] == []
    ), "a strict record's content declaration was answered"
    assert await count(db_session, AgentSession) == 0
    assert await count(db_session, AgentSessionEvent) == 0
    assert await count(db_session, AgentSessionCapture) == 0
    await assert_no_declaration_kept(db_session)


async def test_ingest_hermes_record_declaring_only_contents_is_rejected_invalid(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    record = with_contents(hermes_record([], device["mapping_id"]))
    result = await ingest(device_client, device, [record])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert result["contents"] == []
    assert await count(db_session, AgentSession) == 0
    assert await count(db_session, AgentSessionCapture) == 0
    await assert_no_declaration_kept(db_session)


async def test_ingest_hermes_record_declaring_contents_to_a_rich_mapping_is_rejected_invalid(
    client, device_client, db_session, test_workspace, test_board
):
    enrolled = await enroll_rich(
        client, device_client, db_session, test_workspace, test_board
    )
    policy = await client.patch(
        f"{ME}/{enrolled['installation_id']}/policy",
        json={"enabled_agents": ENABLED_WITH_HERMES},
    )
    assert policy.status_code == 200, policy.text
    event = hermes_event("post_tool_call", working_directory=".")
    # Inside the rich grant, where a declared body would be accepted.
    event["timestamp"] = "2026-10-08T14:04:20Z"
    record = with_contents(
        hermes_record(
            [event], enrolled["mapping_id"], captured_at="2026-10-08T14:04:21Z"
        )
    )
    result = await ingest(device_client, enrolled, [record])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert result["contents"] == []
    assert await count(db_session, AgentSessionEvent) == 0
    assert await count(db_session, AgentSessionCapture) == 0
    await assert_no_declaration_kept(db_session)


async def test_ingest_hermes_record_declaring_contents_adds_nothing_to_a_known_session(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    before_session = summary(await only_session(db_session))
    before_events = set(await stored_events(db_session))
    before_receipts = set(await receipts(db_session))

    fresh = hermes_event("post_tool_call")
    fresh["event"]["id"] = str(uuid.uuid4())
    fresh["gen_ai"]["tool"]["call"]["id"] = "toolu_02Declared"
    record = with_contents(hermes_record([fresh], device["mapping_id"]))
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert result["contents"] == []
    assert set(await stored_events(db_session)) == before_events
    assert set(await receipts(db_session)) == before_receipts
    assert summary(await only_session(db_session)) == before_session
    await assert_no_declaration_kept(db_session)


async def test_ingest_claude_code_record_declaring_contents_is_still_received(
    device_client, enroll_hermes, db_session
):
    """Guard: refusing declarations is strict-harness only."""
    device = await enroll_hermes()
    event = hermes_event("post_tool_call")
    record = with_contents(claude_code_record(event, device["mapping_id"]))
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == []
    assert result["acknowledged"] == [record["capture_id"]]
    assert len(result["contents"]) == 1
    assert await count(db_session, AgentSessionContent) == 1


# --- 12. an event id is one capture's ------------------------------------------------------


async def test_ingest_hermes_record_reusing_one_event_id_is_refused_whole(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    before_events = {
        event_id: (row.event, row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    }
    before_session = summary(await only_session(db_session))

    fresh = hermes_event("post_tool_call")
    fresh["event"]["id"] = str(uuid.uuid4())
    fresh["gen_ai"]["tool"]["call"]["id"] = "toolu_02Fresh"
    reused = hermes_event("on_session_finalize")
    reused["timestamp"] = "2026-09-24T12:31:07.000001Z"
    record = hermes_record(
        [fresh, reused], device["mapping_id"], capture_id=uuid.uuid4().hex
    )
    result = await ingest(device_client, device, [record])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "conflict"}
    ]
    # Refused whole: the record's fresh event is not stored either.
    assert {
        event_id: (row.event, row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    } == before_events
    assert record["capture_id"] not in await receipts(db_session)
    session = await only_session(db_session)
    assert summary(session) == before_session
    assert session.capture_gaps == 1


async def test_ingest_claude_code_event_id_reused_in_new_capture_is_still_received(
    device_client, enroll_hermes, db_session
):
    """Guard: the event-level conflict is strict-harness only; another
    harness's reused event id is still skipped, first copy kept."""
    device = await enroll_hermes()
    first = claude_code_record(hermes_event("post_tool_call"), device["mapping_id"])
    await ingest(device_client, device, [first])
    event_id = first["events"][0]["event"]["id"]
    before = (await stored_events(db_session))[event_id].capture_id

    reused = copy.deepcopy(first["events"][0])
    _changed_content(reused)
    later = hermes_record(
        [reused],
        device["mapping_id"],
        harness="claude_code",
        collection_method="hook",
        native_session_id=CLAUDE_SESSION,
    )
    result = await ingest(device_client, device, [later])

    assert result["rejected"] == []
    assert result["acknowledged"] == [later["capture_id"]]
    assert (await stored_events(db_session))[event_id].capture_id == before


async def test_ingest_hermes_reopened_session_second_end_is_received(
    device_client, enroll_hermes, db_session
):
    """Guard: a second finalize under its own capture and event id is no
    conflict; the reopened session ends again."""
    device = await enroll_hermes()
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    reopened_at, refinalized_at = (
        "2026-09-24T12:30:00.000001Z",
        "2026-09-24T12:31:07.000001Z",
    )
    reopened = hermes_event("post_tool_call")
    reopened["event"]["id"] = str(uuid.uuid4())
    reopened["timestamp"] = reopened_at
    reopened["gen_ai"]["tool"]["call"]["id"] = "toolu_01Reopened"
    refinalized = hermes_event("on_session_finalize")
    refinalized["event"]["id"] = str(
        uuid.uuid5(
            EVENT_ID_NAMESPACE,
            capture_key("on_session_finalize", refinalized_at) + ":0",
        )
    )
    refinalized["timestamp"] = refinalized_at
    records = [
        hermes_record([reopened], device["mapping_id"], capture_id=uuid.uuid4().hex),
        hermes_record(
            [refinalized],
            device["mapping_id"],
            capture_id=capture_key("on_session_finalize", refinalized_at)[:32],
        ),
    ]
    first = await ingest(device_client, device, [records[0]])
    assert first["rejected"] == []
    assert (await only_session(db_session)).status == "active"
    second = await ingest(device_client, device, [records[1]])

    assert second["rejected"] == []
    session = await only_session(db_session)
    assert session.status == "ended"
    assert as_naive(session.ended_at) == naive_utc(refinalized_at)
    assert session.capture_gaps == 0


# --- 13. the receipt hashes only what the strict projection keeps ---------------------------


def record_hash(record: dict) -> str:
    return hashlib.sha256(canonical_json(record).encode()).hexdigest()


@pytest.mark.parametrize("event_name", HERMES_EVENTS)
async def test_ingest_hermes_receipt_hash_covers_only_the_strict_projection(
    device_client, enroll_hermes, db_session, event_name
):
    device = await enroll_hermes()
    capture_id = capture_key(event_name)[:32]
    kept = hermes_record(
        [hermes_event(event_name)], device["mapping_id"], capture_id=capture_id
    )
    uploaded = hermes_record(
        [smuggled(event_name)], device["mapping_id"], capture_id=capture_id
    )
    result = await ingest(device_client, device, [uploaded])
    assert result["rejected"] == []

    receipt = (await receipts(db_session))[capture_id]
    assert receipt.content_hash == record_hash(
        kept
    ), "the receipt hashes the uploaded record, smuggled leaves included"
    over_smuggled = record_hash(uploaded)
    offending = [row for row in await stored_rows(db_session) if over_smuggled in row]
    assert offending == [], f"a hash over the smuggled bytes is stored: {offending[:1]}"


@pytest.mark.parametrize(
    "smuggled_first", [True, False], ids=["smuggled-then-kept", "kept-then-smuggled"]
)
async def test_ingest_hermes_same_capture_differing_only_in_dropped_leaves_is_a_replay(
    device_client, enroll_hermes, db_session, smuggled_first
):
    device = await enroll_hermes()
    capture_id = capture_key("post_tool_call")[:32]
    kept = hermes_record(
        [hermes_event("post_tool_call")], device["mapping_id"], capture_id=capture_id
    )
    uploaded = hermes_record(
        [smuggled("post_tool_call")], device["mapping_id"], capture_id=capture_id
    )
    first, second = (uploaded, kept) if smuggled_first else (kept, uploaded)
    assert (await ingest(device_client, device, [first]))["rejected"] == []
    before_receipts = {
        key: (row.content_hash, as_naive(row.received_at))
        for key, row in (await receipts(db_session)).items()
    }
    before_events = {
        event_id: (row.event, row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    }
    before_session = summary(await only_session(db_session))

    result = await ingest(device_client, device, [second])

    assert result["rejected"] == []
    assert result["acknowledged"] == [capture_id]
    assert {
        key: (row.content_hash, as_naive(row.received_at))
        for key, row in (await receipts(db_session)).items()
    } == before_receipts
    assert {
        event_id: (row.event, row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    } == before_events
    session = await only_session(db_session)
    assert summary(session) == before_session
    assert session.capture_gaps == 0


async def test_ingest_hermes_identical_smuggled_upload_is_a_replay(
    device_client, enroll_hermes, db_session
):
    """Guard: an identical upload stays a replay."""
    device = await enroll_hermes()
    records = [
        hermes_record(
            [smuggled(name)], device["mapping_id"], capture_id=capture_key(name)[:32]
        )
        for name in HERMES_EVENTS
    ]
    assert (await ingest(device_client, device, records))["rejected"] == []
    before_receipts = {
        key: (row.content_hash, as_naive(row.received_at))
        for key, row in (await receipts(db_session)).items()
    }

    result = await ingest(device_client, device, copy.deepcopy(records))

    assert result["rejected"] == []
    assert result["acknowledged"] == [record["capture_id"] for record in records]
    assert {
        key: (row.content_hash, as_naive(row.received_at))
        for key, row in (await receipts(db_session)).items()
    } == before_receipts
    assert (await only_session(db_session)).capture_gaps == 0


async def test_ingest_claude_code_receipt_hash_still_covers_the_uploaded_record(
    device_client, enroll_hermes, db_session
):
    """Guard: hashing the strict projection is strict-harness only."""
    device = await enroll_hermes()
    record = claude_code_record(smuggled("post_tool_call"), device["mapping_id"])
    result = await ingest(device_client, device, [record])
    assert result["rejected"] == []
    assert (await receipts(db_session))[
        record["capture_id"]
    ].content_hash == record_hash(record)


# --- 14. a strict record's harness_version is a version or nothing -------------------------

OFF_PATTERN_HARNESS_VERSIONS = [
    pytest.param(f"{SENTINEL} make deploy", id="free-text"),
    pytest.param("1" * 33, id="longer-than-32"),
    pytest.param("-0.22.4", id="leading-dash"),
    pytest.param(".0.22", id="leading-dot"),
    pytest.param("0.22.4 (hermes)", id="spaces-and-parentheses"),
    pytest.param("0.22.4/linux", id="slash"),
    pytest.param("0.22_4", id="underscore"),
]

KEPT_HARNESS_VERSIONS = ["0.22.4", "1.0.0+build.7", "2026.10.1-rc1", "A", "9" * 32]


@pytest.mark.parametrize("harness_version", OFF_PATTERN_HARNESS_VERSIONS)
async def test_ingest_hermes_off_pattern_harness_version_is_stored_as_null(
    device_client, enroll_hermes, db_session, harness_version
):
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    for record in records:
        record["harness_version"] = harness_version
    result = await ingest(device_client, device, records)

    assert result["rejected"] == []
    assert result["acknowledged"] == [record["capture_id"] for record in records]
    assert (await only_session(db_session)).harness_version is None
    if len(harness_version) >= 8:
        offending = [
            row
            for row in await stored_rows(db_session, prefixes=SESSION_TABLES)
            if harness_version in row
        ]
        assert offending == [], f"{harness_version!r} stored in {offending[:2]}"


async def test_ingest_hermes_off_pattern_harness_version_keeps_the_last_kept_one(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    records[0]["harness_version"] = "0.22.4"
    for later in records[1:]:
        later["harness_version"] = f"{SENTINEL} make deploy"
    result = await ingest(device_client, device, records)

    assert result["rejected"] == []
    assert (await only_session(db_session)).harness_version == "0.22.4"
    offending = [row for row in await stored_rows(db_session) if SENTINEL in row]
    assert offending == [], f"{SENTINEL!r} stored in {offending[:2]}"


@pytest.mark.parametrize("harness_version", KEPT_HARNESS_VERSIONS)
async def test_ingest_hermes_harness_version_inside_its_pattern_is_kept(
    device_client, enroll_hermes, db_session, harness_version
):
    """Guard: a version that fits the pattern is kept as sent."""
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    for record in records:
        record["harness_version"] = harness_version
    result = await ingest(device_client, device, records)
    assert result["rejected"] == []
    assert (await only_session(db_session)).harness_version == harness_version


async def test_ingest_claude_code_harness_version_is_still_kept_as_sent(
    device_client, enroll_hermes, db_session
):
    """Guard: the harness_version pattern is strict-harness only."""
    device = await enroll_hermes()
    record = claude_code_record(hermes_event("post_tool_call"), device["mapping_id"])
    record["harness_version"] = "2.0.14 (Claude Code)"
    result = await ingest(device_client, device, [record])
    assert result["rejected"] == []
    assert (await only_session(db_session)).harness_version == "2.0.14 (Claude Code)"


# --- 15. each strict leaf keeps only values of its pattern -----------------------------------

# (event, leaf, a value outside the leaf's pattern). Each still parses as
# Beacon schema 1.0, so only the leaf's own pattern can drop it.
OFF_PATTERN_LEAVES = [
    pytest.param(
        "post_tool_call", "status", f"{SENTINEL} exit 0", id="status-free-text"
    ),
    pytest.param("post_tool_call", "status", "success", id="status-outside-the-enum"),
    pytest.param("post_tool_call", "status", "OK", id="status-other-case"),
    pytest.param(
        "post_tool_call", "event.category", f"{SENTINEL} category", id="event-category"
    ),
    pytest.param("post_tool_call", "event.kind", f"{SENTINEL} kind", id="event-kind"),
    # event.fidelity parses up to 16 characters.
    pytest.param(
        "post_tool_call", "event.fidelity", "Q9-Fidelity!", id="event-fidelity"
    ),
    pytest.param(
        "post_tool_call", "harness.name", f"{SENTINEL} harness", id="harness-name"
    ),
    pytest.param(
        "post_tool_call",
        "harness.collection_method",
        f"{SENTINEL} method",
        id="harness-collection-method",
    ),
    pytest.param(
        "post_tool_call",
        "gen_ai.operation.name",
        f"{SENTINEL} operation",
        id="gen-ai-operation-name",
    ),
    pytest.param(
        "post_tool_call",
        "mcp.method.name",
        f"{SENTINEL}/tools/call",
        id="mcp-method-name",
    ),
    pytest.param(
        "post_approval_response",
        "approval.decision",
        f"{SENTINEL} deny",
        id="approval-decision",
    ),
    pytest.param(
        "post_approval_response",
        "approval.decision",
        "Deny",
        id="approval-decision-other-case",
    ),
    pytest.param(
        "post_tool_call", "tool.name", f"{SENTINEL} make clean", id="tool-name"
    ),
    pytest.param(
        "post_tool_call", "tool.name", "t" * 129, id="tool-name-longer-than-128"
    ),
    pytest.param("post_tool_call", "mcp.server", f"{SENTINEL} server", id="mcp-server"),
    pytest.param("post_tool_call", "mcp.tool", f"{SENTINEL} tool", id="mcp-tool"),
    pytest.param(
        "post_tool_call",
        "gen_ai.tool.name",
        f"{SENTINEL} tool name",
        id="gen-ai-tool-name",
    ),
    pytest.param(
        "post_tool_call",
        "gen_ai.tool.call.id",
        f"{SENTINEL} make deploy",
        id="gen-ai-tool-call-id",
    ),
    pytest.param(
        "post_tool_call",
        "gen_ai.tool.call.id",
        "toolu_" + "A" * 300,
        id="gen-ai-tool-call-id-longer-than-a-native-id",
    ),
    pytest.param(
        "post_tool_call", "schema_version", f"1.0 {SENTINEL}", id="schema-version"
    ),
    pytest.param(
        "post_tool_call", "schema_version", "v1", id="schema-version-not-dotted-numbers"
    ),
]

INSIDE_PATTERN_LEAVES = [
    pytest.param("post_tool_call", "status", "error", id="status-error"),
    pytest.param("post_tool_call", "status", "blocked", id="status-blocked"),
    pytest.param("post_tool_call", "status", "cancelled", id="status-cancelled"),
    pytest.param(
        "post_tool_call", "tool.name", "mcp:backplane.get-card_2", id="tool-name"
    ),
    pytest.param("post_tool_call", "tool.name", "t" * 128, id="tool-name-of-128"),
    pytest.param(
        "post_tool_call",
        "gen_ai.tool.call.id",
        "call_x|fc_ab+/cd==",
        id="composite-call-id",
    ),
    pytest.param(
        "post_tool_call", "gen_ai.tool.call.id", "t" + "A" * 199, id="call-id-of-200"
    ),
    pytest.param(
        "post_tool_call",
        "mcp.method.name",
        "notifications/tools/list_changed",
        id="mcp-method-name",
    ),
    pytest.param("post_tool_call", "schema_version", "1.0.12", id="schema-version"),
    pytest.param("post_tool_call", "event.fidelity", "inferred", id="event-fidelity"),
]


@pytest.mark.parametrize("event_name,path,value", OFF_PATTERN_LEAVES)
async def test_ingest_hermes_value_outside_its_leaf_pattern_is_dropped(
    device_client, enroll_hermes, db_session, event_name, path, value
):
    device = await enroll_hermes()
    uploaded = hermes_event(event_name)
    assert path in leaves(uploaded), "setup: the golden event carries the leaf"
    set_path(uploaded, path, value)
    result = await ingest(
        device_client, device, [hermes_record([uploaded], device["mapping_id"])]
    )
    assert result["rejected"] == []

    [row] = (await stored_events(db_session)).values()
    assert REDACTIONS_KEY not in row.event
    expected = leaves(hermes_event(event_name))
    del expected[path]
    assert leaves(row.event) == expected, f"{path}={value!r} was kept"
    rows = await stored_rows(db_session)
    assert [
        stored for stored in rows if digest_of(value) in stored
    ] == [], "the dropped value's sha256 is stored"
    if len(value) >= 8:
        offending = [stored for stored in rows if value in stored]
        assert offending == [], f"{value!r} stored in {offending[:2]}"


@pytest.mark.parametrize("content_level", ["metadata", "standard", "full"])
async def test_ingest_hermes_values_outside_their_leaf_patterns_are_dropped_at_every_level(
    device_client, enroll_hermes, db_session, content_level
):
    device = await enroll_hermes(content_level=content_level)
    uploaded = hermes_event(
        "post_tool_call", working_directory=COMPANION_ROOT_DIRECTORY[content_level]
    )
    off_pattern = {
        path: value
        for event_name, path, value in (param.values for param in OFF_PATTERN_LEAVES)
        if event_name == "post_tool_call"
    }
    for path, value in off_pattern.items():
        set_path(uploaded, path, value)
    result = await ingest(
        device_client, device, [hermes_record([uploaded], device["mapping_id"])]
    )
    assert result["rejected"] == []

    [row] = (await stored_events(db_session)).values()
    expected = {
        path: leaf
        for path, leaf in leaves(hermes_event("post_tool_call")).items()
        if path not in off_pattern
    }
    assert leaves(row.event) == expected
    offending = [
        stored
        for stored in await stored_rows(db_session, prefixes=EVENT_TABLES)
        if SENTINEL in stored
    ]
    assert offending == [], f"{SENTINEL!r} stored in {offending[:2]}"


async def test_ingest_hermes_free_text_event_action_is_never_stored(
    device_client, enroll_hermes, db_session
):
    # event.action is required: past its pattern the event has no action left.
    device = await enroll_hermes()
    uploaded = hermes_event("post_tool_call")
    uploaded["event"]["action"] = f"{SENTINEL} make deploy"
    await ingest(
        device_client, device, [hermes_record([uploaded], device["mapping_id"])]
    )
    offending = [row for row in await stored_rows(db_session) if SENTINEL in row]
    assert offending == [], f"{SENTINEL!r} stored in {offending[:2]}"


@pytest.mark.parametrize("event_name,path,value", INSIDE_PATTERN_LEAVES)
async def test_ingest_hermes_value_inside_its_leaf_pattern_is_kept(
    device_client, enroll_hermes, db_session, event_name, path, value
):
    """Guard: every value that fits its leaf's pattern is kept as sent."""
    device = await enroll_hermes()
    uploaded = hermes_event(event_name)
    set_path(uploaded, path, value)
    result = await ingest(
        device_client, device, [hermes_record([uploaded], device["mapping_id"])]
    )
    assert result["rejected"] == []
    [row] = (await stored_events(db_session)).values()
    assert leaves(row.event) == leaves(uploaded)


async def test_ingest_hermes_value_outside_its_leaf_pattern_is_not_in_the_receipt_hash(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    capture_id = capture_key("post_tool_call")[:32]
    uploaded_event = hermes_event("post_tool_call")
    uploaded_event["status"] = f"{SENTINEL} exit 0"
    kept_event = hermes_event("post_tool_call")
    del kept_event["status"]
    uploaded = hermes_record(
        [uploaded_event], device["mapping_id"], capture_id=capture_id
    )
    kept = hermes_record([kept_event], device["mapping_id"], capture_id=capture_id)
    result = await ingest(device_client, device, [uploaded])
    assert result["rejected"] == []
    assert (await receipts(db_session))[capture_id].content_hash == record_hash(kept)


# --- 16. an event id appears once in a strict record ----------------------------------------


def _fresh_tool_call() -> dict:
    event = hermes_event("post_tool_call")
    event["event"]["id"] = str(uuid.uuid4())
    event["timestamp"] = "2026-09-24T12:20:00.000001Z"
    event["gen_ai"]["tool"]["call"]["id"] = "toolu_02Twice"
    return event


async def test_ingest_hermes_identical_event_repeated_within_one_record_is_refused_as_conflict(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    event = hermes_event("post_tool_call")
    record = hermes_record([event, copy.deepcopy(event)], device["mapping_id"])
    result = await ingest(device_client, device, [record])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "conflict"}
    ]
    assert await count(db_session, AgentSession) == 0
    assert await count(db_session, AgentSessionEvent) == 0
    assert await count(db_session, AgentSessionCapture) == 0


async def test_ingest_hermes_event_id_repeated_within_one_record_adds_nothing_to_a_known_session(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    await ingest(device_client, device, companion_records(device["mapping_id"]))
    before_events = {
        event_id: (row.event, row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    }
    before_receipts = set(await receipts(db_session))
    before_session = summary(await only_session(db_session))

    fresh = _fresh_tool_call()
    again = copy.deepcopy(fresh)
    _changed_content(again)
    record = hermes_record(
        [fresh, again], device["mapping_id"], capture_id=uuid.uuid4().hex
    )
    result = await ingest(device_client, device, [record])

    assert result["acknowledged"] == []
    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "conflict"}
    ]
    assert {
        event_id: (row.event, row.capture_id)
        for event_id, row in (await stored_events(db_session)).items()
    } == before_events
    assert set(await receipts(db_session)) == before_receipts
    session = await only_session(db_session)
    assert summary(session) == before_session
    assert session.capture_gaps == 1


async def test_ingest_hermes_event_id_repeated_within_one_record_spares_the_rest_of_the_batch(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    twice = _fresh_tool_call()
    repeated = hermes_record(
        [twice, copy.deepcopy(twice)], device["mapping_id"], capture_id=uuid.uuid4().hex
    )
    result = await ingest(device_client, device, [*records, repeated])

    assert result["acknowledged"] == [record["capture_id"] for record in records]
    assert result["rejected"] == [
        {"capture_id": repeated["capture_id"], "reason": "conflict"}
    ]
    assert set(await stored_events(db_session)) == {
        record["events"][0]["event"]["id"] for record in records
    }


async def test_ingest_claude_code_event_id_repeated_within_one_record_is_still_received(
    device_client, enroll_hermes, db_session
):
    """Guard: refusing a repeated event id is strict-harness only; another
    harness keeps the first copy."""
    device = await enroll_hermes()
    first = hermes_event("post_tool_call")
    first["harness"].update(name="claude_code", collection_method="hook")
    first["session"]["id"] = CLAUDE_SESSION
    second = copy.deepcopy(first)
    _changed_content(second)
    record = hermes_record(
        [first, second],
        device["mapping_id"],
        harness="claude_code",
        collection_method="hook",
        native_session_id=CLAUDE_SESSION,
    )
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == []
    assert result["acknowledged"] == [record["capture_id"]]
    stored = await stored_events(db_session)
    assert list(stored) == [first["event"]["id"]]
    assert stored[first["event"]["id"]].tool_name == "mcp__backplane__get_card"


@pytest.mark.parametrize(
    "event_id",
    [
        f"{SENTINEL}-event-id",
        "not-a-uuid",
        "8aff1481-adbd-5808-b48a-040d4be7daba-extra",
    ],
)
async def test_ingest_hermes_event_id_outside_the_uuid_shape_refuses_the_record(
    device_client, enroll_hermes, db_session, event_id
):
    # The adapter names every event with a UUID; anything else is not a Hermes
    # event id, and dropping it would make the server name the event by a hash.
    device = await enroll_hermes()
    uploaded = hermes_event("post_tool_call")
    uploaded["event"]["id"] = event_id
    record = hermes_record([uploaded], device["mapping_id"])
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert await stored_events(db_session) == {}
    assert [row for row in await stored_rows(db_session) if event_id in row] == []


# --- 17. a strict record keeps no record-level value outside its patterns -------------------

PARENT_SENTINEL = f"{SENTINEL}_parent"
OFF_PATTERN_BEACON_COMMITS = [
    pytest.param(f"{SENTINEL} make deploy", id="free-text"),
    pytest.param("B17031414618", id="upper-case"),
    pytest.param(BEACON_COMMIT[:12], id="abbreviated"),
    pytest.param(BEACON_COMMIT + "0", id="41-hex"),
    pytest.param("b17031414618\n", id="trailing-newline"),
]
OFF_PATTERN_BEACON_SCHEMAS = [
    pytest.param(f"{SENTINEL[:12]} 1", id="free-text"),
    pytest.param("1.0\n", id="trailing-newline"),
    pytest.param("v1", id="prefixed"),
]


async def test_ingest_hermes_parent_session_id_is_never_stored(
    device_client, enroll_hermes, db_session
):
    # The adapter never names a parent: a strict record carries no link it
    # did not observe.
    device = await enroll_hermes()
    records = companion_records(device["mapping_id"])
    for record in records:
        record["parent_native_session_id"] = PARENT_SENTINEL
    result = await ingest(device_client, device, records)

    assert result["rejected"] == []
    session = await only_session(db_session)
    assert session.parent_native_session_id is None
    assert session.parent_session_id is None
    assert [
        row for row in await stored_rows(db_session) if PARENT_SENTINEL in row
    ] == []


@pytest.mark.parametrize("commit", OFF_PATTERN_BEACON_COMMITS)
async def test_ingest_hermes_off_pattern_beacon_commit_is_stored_as_null(
    device_client, enroll_hermes, db_session, commit
):
    device = await enroll_hermes()
    record = hermes_record(
        [hermes_event("post_tool_call")],
        device["mapping_id"],
        beacon={"commit": commit, "schema_version": "1.0"},
    )
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == []
    receipt = (await receipts(db_session))[record["capture_id"]]
    assert receipt.beacon_commit is None
    assert receipt.beacon_schema_version == "1.0"
    if SENTINEL in commit:
        assert [row for row in await stored_rows(db_session) if SENTINEL in row] == []


@pytest.mark.parametrize("schema_version", OFF_PATTERN_BEACON_SCHEMAS)
async def test_ingest_hermes_off_pattern_beacon_schema_version_is_stored_as_null(
    device_client, enroll_hermes, db_session, schema_version
):
    device = await enroll_hermes()
    record = hermes_record(
        [hermes_event("post_tool_call")],
        device["mapping_id"],
        beacon={"commit": BEACON_COMMIT, "schema_version": schema_version},
    )
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == []
    receipt = (await receipts(db_session))[record["capture_id"]]
    assert receipt.beacon_commit == BEACON_COMMIT
    assert receipt.beacon_schema_version is None


@pytest.mark.parametrize("commit", [BEACON_COMMIT, "a" * 64])
async def test_ingest_hermes_beacon_commit_inside_its_pattern_is_kept(
    device_client, enroll_hermes, db_session, commit
):
    device = await enroll_hermes()
    record = hermes_record(
        [hermes_event("post_tool_call")],
        device["mapping_id"],
        beacon={"commit": commit, "schema_version": "1.0"},
    )
    assert (await ingest(device_client, device, [record]))["rejected"] == []

    assert (await receipts(db_session))[record["capture_id"]].beacon_commit == commit


def with_dropped_record_values(record: dict) -> dict:
    """The record with a parent, off-pattern provenance and a device path
    whose folder is the kept one: values the strict record does not keep."""
    changed = copy.deepcopy(record)
    changed["parent_native_session_id"] = PARENT_SENTINEL
    changed["beacon"] = {"commit": f"{SENTINEL} free text", "schema_version": "v1"}
    for event in changed["events"]:
        event["session"]["working_directory"] = (
            f"{SYNTHETIC_HOME}/{SENTINEL}/{HERMES_FOLDER}"
        )
    return changed


def as_strict_record(record: dict) -> dict:
    kept = {**record, "beacon": {"commit": None, "schema_version": None}}
    kept.pop("parent_native_session_id", None)
    return kept


async def test_ingest_hermes_receipt_hash_covers_no_dropped_record_value(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    capture_id = capture_key("post_tool_call")[:32]
    kept = hermes_record(
        [hermes_event("post_tool_call")], device["mapping_id"], capture_id=capture_id
    )
    uploaded = with_dropped_record_values(kept)
    assert (await ingest(device_client, device, [uploaded]))["rejected"] == []

    receipt = (await receipts(db_session))[capture_id]
    assert receipt.content_hash == record_hash(as_strict_record(kept))
    offending = [
        row
        for row in await stored_rows(db_session)
        if record_hash(uploaded) in row or SENTINEL in row
    ]
    assert (
        offending == []
    ), f"a dropped record value or its hash is stored: {offending[:1]}"


@pytest.mark.parametrize(
    "dropped_first", [True, False], ids=["dropped-then-kept", "kept-then-dropped"]
)
async def test_ingest_hermes_same_capture_differing_only_in_dropped_record_values_is_a_replay(
    device_client, enroll_hermes, db_session, dropped_first
):
    device = await enroll_hermes()
    capture_id = capture_key("post_tool_call")[:32]
    kept = as_strict_record(
        hermes_record(
            [hermes_event("post_tool_call")],
            device["mapping_id"],
            capture_id=capture_id,
        )
    )
    uploaded = with_dropped_record_values(kept)
    first, second = (uploaded, kept) if dropped_first else (kept, uploaded)
    assert (await ingest(device_client, device, [first]))["rejected"] == []
    before_hash = (await receipts(db_session))[capture_id].content_hash

    result = await ingest(device_client, device, [second])

    assert result["rejected"] == []
    assert result["acknowledged"] == [capture_id]
    assert (await receipts(db_session))[capture_id].content_hash == before_hash
    assert (await only_session(db_session)).capture_gaps == 0


async def test_ingest_hermes_event_id_with_a_trailing_newline_refuses_the_record(
    device_client, enroll_hermes, db_session
):
    device = await enroll_hermes()
    uploaded = hermes_event("post_tool_call")
    uploaded["event"]["id"] += "\n"
    record = hermes_record([uploaded], device["mapping_id"])
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == [
        {"capture_id": record["capture_id"], "reason": "invalid"}
    ]
    assert await stored_events(db_session) == {}


# Hermes mints `call_<12 hex>` from the tool name and arguments
# (agent/message_sanitization.py deterministic_call_id), renames repeats
# `<id>_d<n>` and bridges spell a call `<call id>|<item id>`: the server drops
# each of these shapes itself rather than trusting the companion to replace it.
MINTED_CALL_IDS = [
    "call_d77e5863c9b8",
    "call_d77e5863c9b8_d2",
    "call_d77e5863c9b8_d2_d3",
    "call_d77e5863c9b8|fc_d77e5863c9b8",
    "call_d77e5863c9b8_d2|fc_68f0c2a1b3d4e5f60718293a",
]


@pytest.mark.parametrize("call_id", MINTED_CALL_IDS)
async def test_ingest_hermes_minted_call_id_is_never_stored(
    device_client, enroll_hermes, db_session, call_id
):
    device = await enroll_hermes()
    uploaded = hermes_event("post_tool_call")
    uploaded["gen_ai"]["tool"]["call"]["id"] = call_id
    record = hermes_record([uploaded], device["mapping_id"])
    result = await ingest(device_client, device, [record])

    assert result["rejected"] == []
    [row] = (await stored_events(db_session)).values()
    assert "id" not in ((row.event.get("gen_ai") or {}).get("tool") or {}).get(
        "call", {}
    )
    assert [
        stored for stored in await stored_rows(db_session) if "d77e5863c9b8" in stored
    ] == []


@pytest.mark.parametrize(
    "call_id",
    [
        "call_b57d26af38ac4e67ae4e",
        "call_d77e5863c9b8_dx",
        "call_d77e5863c9b8a",
        "toolu_01AbCdEf",
    ],
)
async def test_ingest_hermes_provider_call_id_is_kept(
    device_client, enroll_hermes, db_session, call_id
):
    device = await enroll_hermes()
    uploaded = hermes_event("post_tool_call")
    uploaded["gen_ai"]["tool"]["call"]["id"] = call_id
    record = hermes_record([uploaded], device["mapping_id"])
    assert (await ingest(device_client, device, [record]))["rejected"] == []

    [row] = (await stored_events(db_session)).values()
    assert row.event["gen_ai"]["tool"]["call"]["id"] == call_id
