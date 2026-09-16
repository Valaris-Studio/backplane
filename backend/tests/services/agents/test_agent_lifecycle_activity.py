# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Agent lifecycle transitions must leave a durable audit trail (card 1ed41312).

The WS bus is ephemeral: `agent.paused` / `agent.hard_deleted` and friends tell
a connected frontend what just happened and are then gone. Nothing persisted
"who disabled this runner and when", which is the question an operator actually
asks days later.

All six lifecycle actions now write exactly one `activities` row through
ActivityService. Coverage here is service-level (the HTTP shape of these
endpoints is already pinned by tests/test_agent_restart_hard_delete.py,
tests/test_poll_agent.py and tests/routers/agents/test_agent_pause.py).

Two properties are load-bearing and each has a dedicated test:

- **workspace binding**: `Activity.workspace_id` is NOT NULL, and an agent with
  an empty `allowed_workspaces` resolves to no workspace. Recording must SKIP,
  never raise — an audit-log gap is bad, but failing the operator's pause
  because of one is worse. Every agent built here is workspace-bound so the
  "exactly one row" assertions are meaningful.
- **hard delete outlives its agent**: `activities.agent_id` is
  `ON DELETE SET NULL` and `entity_id` is a plain UUID column with no FK, so the
  evidence survives the row it describes. SQLite runs with
  `PRAGMA foreign_keys=ON` in this suite, so the assertion is real here.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace
from app.services.agents.agent import AgentService
from app.services.events.connection_manager import (
    WebSocketConnection,
    connection_manager,
)


async def _make_agent(
    db: AsyncSession,
    owner: User,
    workspace_slug: str | None,
    *,
    name: str,
    paused: bool = False,
) -> Agent:
    """A workspace-bound agent unless workspace_slug is None.

    `allowed_workspaces=[]` is the unbound case `_resolve_workspace_id` answers
    None for — used only by the skip test.
    """
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="",
        created_by_id=owner.id,
        allowed_workspaces=[workspace_slug] if workspace_slug else [],
        is_active=True,
        is_paused=paused,
    )
    db.add(agent)
    await db.flush()
    return agent


async def _agent_activities(db: AsyncSession, agent_id: uuid.UUID) -> list[Activity]:
    """Every activity row describing this agent, oldest first.

    Filters on entity_type too: a lifecycle action must not be findable only by
    id — it has to be classified as an `agent` event to be queryable in the feed.
    """
    result = await db.execute(
        select(Activity)
        .where(
            Activity.entity_type == ActivityEntityType.agent,
            Activity.entity_id == agent_id,
        )
        .order_by(Activity.seq)
    )
    return list(result.scalars().all())


def _connect(workspace: Workspace, user: User, agent: Agent) -> WebSocketConnection:
    conn = WebSocketConnection(
        websocket=AsyncMock(),
        workspace_id=workspace.id,
        user_id=user.id,
        agent_id=agent.id,
    )
    connection_manager._connections.append(conn)
    return conn


def _assert_structured_lifecycle(
    row: Activity,
    *,
    lifecycle: str,
    agent_name: str,
) -> None:
    assert row.message_key == f"activity.agent.{lifecycle}"
    assert row.message_params == {"agent_name": agent_name}


# --- AC1: each of the six actions writes exactly one row ---------------------


@pytest.mark.asyncio
async def test_pause_records_one_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-pause"
    )

    await AgentService(db_session).pause_agent(agent.id, test_user.id)

    rows = await _agent_activities(db_session, agent.id)
    assert len(rows) == 1
    assert rows[0].action == ActivityAction.updated
    assert rows[0].changes == {"lifecycle": "paused"}
    assert rows[0].workspace_id == test_workspace.id
    assert rows[0].actor_id == test_user.id
    assert "paused" in rows[0].summary
    assert agent.name in rows[0].summary
    _assert_structured_lifecycle(rows[0], lifecycle="paused", agent_name=agent.name)


@pytest.mark.asyncio
async def test_resume_records_one_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-resume", paused=True
    )

    await AgentService(db_session).resume_agent(agent.id, test_user.id)

    rows = await _agent_activities(db_session, agent.id)
    assert len(rows) == 1
    assert rows[0].changes == {"lifecycle": "resumed"}
    assert "resumed" in rows[0].summary
    _assert_structured_lifecycle(rows[0], lifecycle="resumed", agent_name=agent.name)


@pytest.mark.asyncio
async def test_poll_records_one_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-poll"
    )
    conn = _connect(test_workspace, test_user, agent)
    try:
        await AgentService(db_session).poll_agent(agent.id, test_user.id)
    finally:
        connection_manager._connections.remove(conn)

    rows = await _agent_activities(db_session, agent.id)
    assert len(rows) == 1
    assert rows[0].changes == {"lifecycle": "poll_requested"}
    assert rows[0].action == ActivityAction.updated
    _assert_structured_lifecycle(
        rows[0], lifecycle="poll_requested", agent_name=agent.name
    )


@pytest.mark.asyncio
async def test_soft_disable_records_one_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-disable"
    )

    await AgentService(db_session).deactivate_agent(agent.id, test_user.id)

    rows = await _agent_activities(db_session, agent.id)
    assert len(rows) == 1
    assert rows[0].changes == {"lifecycle": "deactivated"}
    assert rows[0].action == ActivityAction.updated
    _assert_structured_lifecycle(
        rows[0], lifecycle="deactivated", agent_name=agent.name
    )


@pytest.mark.asyncio
async def test_restart_records_one_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-restart"
    )
    conn = _connect(test_workspace, test_user, agent)
    try:
        await AgentService(db_session).restart_agent(agent.id, test_user.id)
    finally:
        connection_manager._connections.remove(conn)

    rows = await _agent_activities(db_session, agent.id)
    assert len(rows) == 1
    assert rows[0].changes == {"lifecycle": "restart_requested"}
    assert rows[0].action == ActivityAction.updated
    _assert_structured_lifecycle(
        rows[0], lifecycle="restart_requested", agent_name=agent.name
    )


@pytest.mark.asyncio
async def test_hard_delete_records_one_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-harddelete"
    )

    await AgentService(db_session).hard_delete_agent(agent.id, test_user.id)

    rows = await _agent_activities(db_session, agent.id)
    assert len(rows) == 1
    # `deleted`, not `updated`: the row describes a removal, and the feed's
    # generic renderer keys off the action verb.
    assert rows[0].action == ActivityAction.deleted
    assert rows[0].changes == {"lifecycle": "hard_deleted"}
    _assert_structured_lifecycle(
        rows[0], lifecycle="hard_deleted", agent_name=agent.name
    )


# --- AC2: the hard-delete row outlives the agent it names --------------------


@pytest.mark.asyncio
async def test_hard_delete_activity_survives_the_agent_and_still_names_it(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """The audit row is the only remaining evidence the agent ever existed.

    `agent_id` is ON DELETE SET NULL and `entity_id` carries no FK, so the row
    persists with the deleted agent's id intact. The NAME must be captured into
    `summary` before the delete — after it, there is nothing left to read it
    from. A future "clean up orphaned activities" job that drops rows whose
    agent_id is NULL would destroy exactly this evidence.
    """
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="doomed-runner"
    )
    agent_id = agent.id

    await AgentService(db_session).hard_delete_agent(agent_id, test_user.id)

    # The agent really is gone.
    gone = await db_session.execute(select(Agent).where(Agent.id == agent_id))
    assert gone.scalar_one_or_none() is None

    rows = await _agent_activities(db_session, agent_id)
    assert len(rows) == 1
    row = rows[0]
    assert row.entity_id == agent_id, "entity_id has no FK — it must survive verbatim"
    assert row.agent_id is None, "FK is ON DELETE SET NULL"
    assert "doomed-runner" in row.summary, "name captured BEFORE the delete"


@pytest.mark.asyncio
async def test_hard_delete_activity_is_written_after_the_row_is_gone(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Ordering test: the audit row must be inserted AFTER `repo.delete_by_id`.

    `agent_id` on the new row is populated from the `current_agent_id`
    contextvar — the actor — so this only becomes observable when a runner
    deletes ITSELF, which is the case that makes the FK real. Recording before
    the delete inserts a live FK to a row that is about to disappear; the audit
    trail then depends on `ON DELETE SET NULL` firing to stay consistent, and
    on any engine that defers or restricts that FK the delete fails outright.
    Recording after means the row never references the deleted agent at all.

    Without this test, `test_..._survives_the_agent_and_still_names_it` passes
    under BOTH orderings (its `agent_id is None` holds either way once SET NULL
    has run), so nothing pins the order the production comment promises.
    """
    from app.core.auth import current_agent_id

    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="self-deleting-runner"
    )
    agent_id = agent.id

    token = current_agent_id.set(agent_id)
    try:
        await AgentService(db_session).hard_delete_agent(agent_id, test_user.id)
    finally:
        current_agent_id.reset(token)

    # The delete must have SURVIVED. `record` stamps activities.agent_id from
    # the actor contextvar, so without clear_agent_ref this INSERT references
    # the just-deleted agent and trips the FK. The resulting failed flush
    # poisons the session and rolls the whole transaction back — taking the
    # delete with it — while the `except Exception` around the record makes it
    # look like nothing went wrong.
    gone = await db_session.execute(select(Agent).where(Agent.id == agent_id))
    assert gone.scalar_one_or_none() is None, "audit write must not undo the delete"

    rows = await _agent_activities(db_session, agent_id)
    assert len(rows) == 1
    # Never pointed at the agent: written when the row was already gone.
    assert rows[0].agent_id is None
    assert rows[0].entity_id == agent_id


# --- Workspace resolution: skip, never raise ---------------------------------


@pytest.mark.asyncio
async def test_unbound_agent_pause_skips_recording_without_raising(
    db_session: AsyncSession, test_user: User
):
    """`Activity.workspace_id` is NOT NULL, so an agent bound to no workspace
    cannot get a row. Recording is best-effort: the pause still succeeds."""
    agent = await _make_agent(db_session, test_user, None, name="unbound-runner")

    updated = await AgentService(db_session).pause_agent(agent.id, test_user.id)

    assert updated.is_paused is True
    assert await _agent_activities(db_session, agent.id) == []


# --- Idempotence: a no-op transition writes no row ---------------------------


@pytest.mark.asyncio
async def test_idempotent_pause_does_not_write_a_second_row(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """`_set_paused` returns early when the state already holds. The audit log
    records transitions, not requests — a retried pause is not a second event."""
    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-idempotent"
    )
    service = AgentService(db_session)

    await service.pause_agent(agent.id, test_user.id)
    await service.pause_agent(agent.id, test_user.id)

    assert len(await _agent_activities(db_session, agent.id)) == 1


# --- AC3 (card B5): a rejected audit row must not poison the lifecycle write ---
#
# `_record_lifecycle_activity` swallows activity failures so an audit gap can
# never fail the operator's pause. But `ActivityRepository.record` FLUSHES, so a
# row the DATABASE rejects leaves the Session rollback-only: `get_db`'s commit
# degrades to a rollback and the pause itself is silently discarded. On asyncpg
# the same shape surfaces as InFailedSQLTransactionError.
#
# Asserts the OUTCOME (the pause survives a later statement AND a commit), not
# the Postgres error class — SQLite reproduces the poisoning at the Session
# layer, which is where the fix lives. Do not "fix" this to expect
# InFailedSQLTransactionError.


@pytest.mark.asyncio
async def test_pause_survives_an_activity_row_the_database_rejects(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    monkeypatch,
):
    from datetime import datetime

    from sqlalchemy.exc import PendingRollbackError

    from app.repositories.activity import ActivityRepository

    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-poison"
    )
    agent_id = agent.id

    async def record_with_a_doomed_row(self, **kwargs):
        # An actor_id naming no user violates the FK, so the repo's own flush()
        # raises IntegrityError from the driver — the genuine failure, not a
        # synthetic side_effect that today's bare `except` would swallow anyway.
        kwargs["actor_id"] = uuid.uuid4()
        activity = Activity(created_at=datetime.utcnow(), **kwargs)
        self.db.add(activity)
        await self.db.flush()
        return activity

    monkeypatch.setattr(ActivityRepository, "record", record_with_a_doomed_row)

    await AgentService(db_session).pause_agent(agent_id, test_user.id)

    try:
        await db_session.execute(select(Activity))
    except PendingRollbackError:
        pytest.fail("the rejected activity row left the session rollback-only")

    await db_session.commit()
    reread = await db_session.get(Agent, agent_id)
    assert reread is not None
    assert reread.is_paused is True

    # AC4: the savepoint rolls the failed insert back — no half-written row.
    assert await _agent_activities(db_session, agent_id) == []


@pytest.mark.asyncio
async def test_an_activity_failure_after_the_row_flushed_leaves_no_half_written_row(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    monkeypatch,
):
    """AC4 on the agent side — the case that pins WHERE the savepoint sits.

    `ActivityService.record` keeps working after the repo flushes (entity-title
    resolution, notification generation, event emission), so a failure can land
    with the row already written. Only a savepoint whose `__aexit__` SEES the
    exception rolls that row back; put it outside the try and the `except`
    swallows inside it, `__aexit__` exits cleanly and RELEASEs the savepoint,
    leaving a half-written audit row for a record() that failed.
    """
    from app.services.activity import ActivityService

    agent = await _make_agent(
        db_session, test_user, test_workspace.slug, name="lifecycle-postflush"
    )
    agent_id = agent.id
    real_record = ActivityService.record

    async def record_then_fail(self, **kwargs):
        await real_record(self, **kwargs)
        # Not a DB error: the row is already flushed, the session is healthy.
        raise RuntimeError("notification fan-out blew up after the insert")

    monkeypatch.setattr(ActivityService, "record", record_then_fail)
    await AgentService(db_session).pause_agent(agent_id, test_user.id)

    await db_session.commit()
    reread = await db_session.get(Agent, agent_id)
    assert reread.is_paused is True
    assert await _agent_activities(db_session, agent_id) == []
