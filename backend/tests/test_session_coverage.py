# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Coverage tells a session whose agent reported only token usage apart from
one with captured activity, counted at ingest and exact for older rows too."""

import copy

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine, inspect, select, update

from app.database import get_db
from app.main import create_app
from app.models.agent_session import AgentSession
from app.services.agent_session import recount_next_session_activity
from tests.test_agent_sessions import (
    FIXTURE_EVENTS,
    ME,
    SESSIONS,
    enroll,
    record,
    upload,
)
from tests.test_session_cost_migration import VERSIONS, _at_109, _columns, _load

SESSION_STARTED, PROMPT, TOOL = FIXTURE_EVENTS[0], FIXTURE_EVENTS[1], FIXTURE_EVENTS[2]


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


def _usage(event_id, harness="codex_desktop"):
    """What the companion reads from the Codex app's session log: token counts
    and nothing about what the agent did."""
    return {
        "schema_version": "1.0",
        "timestamp": "2026-09-24T02:21:29Z",
        "event": {"id": event_id, "action": "token.usage", "category": "metric"},
        "harness": {"name": harness, "collection_method": "polling"},
        "model": "gpt-5.4",
        "gen_ai": {"usage": {"input_tokens": 1200, "output_tokens": 300}},
    }


def _renamed(event, event_id):
    event = copy.deepcopy(event)
    event["event"]["id"] = event_id
    return event


async def _only_session(client):
    [item] = (await client.get(SESSIONS)).json()["items"]
    detail = (await client.get(f"{SESSIONS}/{item['id']}")).json()
    assert (item["coverage"], item["activity_event_count"]) == (
        detail["coverage"],
        detail["activity_event_count"],
    )
    return detail


async def _codex_enabled(client):
    for installation in (await client.get(ME)).json():
        response = await client.patch(
            f"{ME}/{installation['installation_id']}/policy",
            json={"enabled_agents": ["claude_code", "codex_cli"]},
        )
        assert response.status_code == 200, response.text


async def test_codex_desktop_usage_only_session_is_usage_only(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await _codex_enabled(client)
    await upload(
        device_client,
        token,
        [
            record(
                [_usage("u-1"), _usage("u-2")],
                mapping_id,
                harness="codex_desktop",
                session="desktop-1",
            )
        ],
    )

    session = await _only_session(client)
    assert session["activity_event_count"] == 0
    assert session["coverage"] == "usage_only"


async def test_one_tool_event_makes_activity(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record([SESSION_STARTED, TOOL], mapping_id)])

    session = await _only_session(client)
    # The lifecycle marker is not activity; the tool call is.
    assert session["activity_event_count"] == 1
    assert session["coverage"] == "activity"


async def test_a_session_with_neither_activity_nor_usage_is_empty(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record([SESSION_STARTED], mapping_id)])

    session = await _only_session(client)
    assert (session["activity_event_count"], session["coverage"]) == (0, "empty")


async def test_replayed_events_are_counted_once(
    client, device_client, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record([PROMPT, TOOL], mapping_id)])
    await upload(
        device_client,
        token,
        [record([PROMPT, TOOL, _renamed(TOOL, "tool-2")], mapping_id)],
    )

    assert (await _only_session(client))["activity_event_count"] == 3


async def test_sessions_counted_before_the_column_existed_read_exactly_and_heal(
    client, device_client, db_session, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(
        device_client,
        token,
        [
            record(
                [SESSION_STARTED, PROMPT, TOOL, _usage("u-1", "claude_code")],
                mapping_id,
            )
        ],
    )
    # What the previous release leaves behind: no count at all.
    await db_session.execute(update(AgentSession).values(activity_event_count=None))
    await db_session.flush()

    session = await _only_session(client)
    assert (session["activity_event_count"], session["coverage"]) == (2, "activity")

    await upload(device_client, token, [record([_renamed(TOOL, "tool-2")], mapping_id)])
    stored = await db_session.scalar(
        select(AgentSession).execution_options(populate_existing=True)
    )
    assert stored.activity_event_count == 3


async def test_recount_fills_unknown_counts_and_corrects_wrong_ones(
    client, device_client, db_session, test_workspace, test_board
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    await upload(device_client, token, [record([PROMPT, TOOL], mapping_id)])
    await upload(
        device_client,
        token,
        [record([TOOL], mapping_id, session="second")],
    )
    sessions = {
        row.native_session_id: row
        for row in await db_session.scalars(select(AgentSession))
    }
    await db_session.execute(
        update(AgentSession)
        .where(AgentSession.native_session_id == "second")
        .values(activity_event_count=None)
    )
    await db_session.execute(
        update(AgentSession)
        .where(AgentSession.id == sessions["sc01-synthetic-session"].id)
        .values(activity_event_count=7)
    )
    await db_session.flush()

    # Only unknown counts by default.
    recounted, after = [], None
    while (after := await recount_next_session_activity(db_session, after)) is not None:
        recounted.append(after)
    assert recounted == [sessions["second"].id]
    # Every count when asked to, which repairs one the previous release let drift.
    recounted, after = [], None
    while (
        after := await recount_next_session_activity(
            db_session, after, only_unknown=False
        )
    ) is not None:
        recounted.append(after)
    assert set(recounted) == {row.id for row in sessions.values()}
    counts = {
        row.native_session_id: row.activity_event_count
        for row in await db_session.scalars(
            select(AgentSession).execution_options(populate_existing=True)
        )
    }
    assert counts == {"sc01-synthetic-session": 2, "second": 1}


def test_coverage_migration_is_additive_leaves_old_rows_unknown_and_reverses(
    tmp_path,
):
    migration = _load(VERSIONS / "115_session_activity_count.py")
    assert (migration.revision, migration.down_revision) == ("115", "114")
    engine = create_engine("sqlite:///" + str(tmp_path / "coverage.db"))
    with engine.begin() as connection:
        _at_109(connection)
        connection.exec_driver_sql(
            "INSERT INTO agent_sessions (id, workspace_id, owner_id, installation_id, "
            "harness, native_session_id, started_at, last_event_at) VALUES "
            "('s', 'w', 'o', 'i', 'claude_code', 'n', '2026-09-25', '2026-09-25')"
        )
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):  # up, down, and up again
            migration.upgrade()
            inspector = inspect(connection)
            # Nullable with no default: the previous release keeps inserting
            # sessions during a rolling deploy, and NULL means "not counted".
            column = next(
                column
                for column in inspector.get_columns("agent_sessions")
                if column["name"] == "activity_event_count"
            )
            assert column["nullable"] and column["default"] is None
            assert (
                connection.exec_driver_sql(
                    "SELECT activity_event_count FROM agent_sessions"
                ).scalar()
                is None
            )
            migration.downgrade()
            assert "activity_event_count" not in _columns(
                inspect(connection), "agent_sessions"
            )
    engine.dispose()
