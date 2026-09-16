# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.utils import utcnow


async def _seed_executions(
    db_session: AsyncSession,
    workspace: Workspace,
    board: Board,
    user: User,
) -> tuple[Agent, Agent]:
    agent_a = Agent(name="coder", agent_type=AgentType.coding, created_by_id=user.id)
    agent_b = Agent(name="reviewer", agent_type=AgentType.reviewer, created_by_id=user.id)
    db_session.add_all([agent_a, agent_b])
    await db_session.flush()

    executions = [
        AgentExecution(
            agent_id=agent_a.id,
            workspace_id=workspace.id,
            board_id=board.id,
            action="implement-feature",
            status=ExecutionStatus.completed,
            input_summary="Build login page",
            output_summary="Login page done",
            tool_calls_count=12,
            tokens_used=5000,
            duration_seconds=45.2,
        ),
        AgentExecution(
            agent_id=agent_a.id,
            workspace_id=workspace.id,
            board_id=board.id,
            action="fix-bug",
            status=ExecutionStatus.failed,
            input_summary="Fix auth bug",
            error_message="Timeout",
            tool_calls_count=3,
        ),
        AgentExecution(
            agent_id=agent_b.id,
            workspace_id=workspace.id,
            action="review-pr",
            status=ExecutionStatus.completed,
            input_summary="Review PR #42",
            output_summary="Approved",
            tool_calls_count=5,
            tokens_used=2000,
            duration_seconds=20.1,
        ),
    ]
    db_session.add_all(executions)
    await db_session.flush()
    return agent_a, agent_b


async def test_list_workspace_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_executions(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/executions")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 3


async def test_list_workspace_executions_inflight_returns_started_and_running(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """status=inflight is the authoritative in-flight filter: status in
    {started,running} AND completed_at IS NULL. It must NOT be subject to the
    50-row newest-first page window — an in-flight row behind a wall of completed
    rows would otherwise vanish and the board would falsely read 'idle'."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    # 60 completed rows (more than the default 50-row page) ...
    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action=f"done-{i}", status=ExecutionStatus.completed,
            input_summary="x", completed_at=datetime(2026, 4, 1, 0, 0, 0),
        )
        for i in range(60)
    ])
    # ... plus one started + one running, the genuinely in-flight work.
    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="implementing", status=ExecutionStatus.started, input_summary="x",
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="running-stage", status=ExecutionStatus.running, input_summary="x",
        ),
    ])
    await db_session.flush()

    response = await client.get("/api/workspaces/default/executions?status=inflight")
    assert response.status_code == 200
    data = response.json()
    statuses = sorted(e["status"] for e in data)
    assert statuses == ["running", "started"], (
        f"in-flight filter must return exactly the 2 active rows regardless of the "
        f"60 completed rows, got {statuses}"
    )


async def test_list_workspace_executions_filter_by_card_returns_outside_window(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """card_id is a card-scoped filter that must NOT be subject to the 50-row
    newest-first window. A done card's pipeline executions are older than the 50
    newest workspace rows; before this filter existed the card-detail sheet
    fetched the newest 50 and filtered client-side → empty history. The filter
    returns exactly the card's rows however old they are."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    old_card = str(uuid.uuid4())
    other_card = str(uuid.uuid4())

    # The done card's 2 pipeline rows, stamped OLD (oldest started_at) so they
    # sit at the very back of the newest-first ordering.
    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="plan", status=ExecutionStatus.completed, input_summary="x",
            started_at=datetime(2026, 1, 1, 0, 0, 0), cards_affected=[old_card],
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="implement", status=ExecutionStatus.completed, input_summary="x",
            started_at=datetime(2026, 1, 1, 1, 0, 0), cards_affected=[old_card],
        ),
    ])
    # 60 newer rows for a DIFFERENT card — more than the 50-row default window.
    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action=f"noise-{i}", status=ExecutionStatus.completed, input_summary="x",
            started_at=datetime(2026, 6, 1, 0, i // 60, i % 60), cards_affected=[other_card],
        )
        for i in range(60)
    ])
    await db_session.flush()

    response = await client.get(f"/api/workspaces/default/executions?card_id={old_card}")
    assert response.status_code == 200
    data = response.json()
    actions = sorted(e["action"] for e in data)
    assert actions == ["implement", "plan"], (
        f"card filter must return exactly the 2 rows for the card regardless of "
        f"the 60 newer rows for another card, got {actions}"
    )
    assert all(old_card in e["cards_affected"] for e in data)


async def test_list_workspace_executions_filter_by_status(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_executions(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/executions?status=completed")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    assert all(e["status"] == "completed" for e in data)


async def test_list_workspace_executions_filter_by_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    agent_a, _ = await _seed_executions(db_session, test_workspace, test_board, test_user)

    response = await client.get(f"/api/workspaces/default/executions?agent_id={agent_a.id}")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    assert all(e["agent_id"] == str(agent_a.id) for e in data)


async def test_list_workspace_executions_ordered_by_started_at_desc(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    await _seed_executions(db_session, test_workspace, test_board, test_user)

    response = await client.get("/api/workspaces/default/executions")
    data = response.json()
    dates = [e["started_at"] for e in data]
    assert dates == sorted(dates, reverse=True)


async def test_list_workspace_executions_empty(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    response = await client.get("/api/workspaces/default/executions")
    assert response.status_code == 200
    assert response.json() == []


# ---------------------------------------------------------------------------
# GET /api/workspaces/{slug}/executions/skipped-card-ids
#
# The board needs to render a per-card "needs prompt" badge for every card
# whose pipeline hit a `skipped` execution (a stage with no cached prompt).
# One flat array of card UUIDs replaces the previous fan-out of one
# GET /executions?card_id= per card (~87 requests → 1), which was exhausting
# the DB connection pool and 500-storming production.
# ---------------------------------------------------------------------------


def _skipped_execution(
    workspace: Workspace, agent: Agent, cards: list[str]
) -> AgentExecution:
    return AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        action="implement",
        status=ExecutionStatus.skipped,
        input_summary="no prompt cached for stage",
        cards_affected=cards,
    )


async def test_skipped_card_ids_returns_cards_from_skipped_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card_1 = str(uuid.uuid4())
    card_2 = str(uuid.uuid4())
    db_session.add_all(
        [
            _skipped_execution(test_workspace, agent, [card_1]),
            _skipped_execution(test_workspace, agent, [card_2]),
        ]
    )
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert sorted(response.json()) == sorted([card_1, card_2])


async def test_skipped_card_ids_excludes_non_skipped_statuses(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    skipped_card = str(uuid.uuid4())
    completed_card = str(uuid.uuid4())
    db_session.add_all(
        [
            _skipped_execution(test_workspace, agent, [skipped_card]),
            AgentExecution(
                agent_id=agent.id,
                workspace_id=test_workspace.id,
                action="implement",
                status=ExecutionStatus.completed,
                input_summary="done",
                cards_affected=[completed_card],
            ),
        ]
    )
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert response.json() == [skipped_card]


async def test_skipped_card_ids_excludes_other_workspaces(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_ws.id,
            user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    mine = str(uuid.uuid4())
    theirs = str(uuid.uuid4())
    db_session.add_all(
        [
            _skipped_execution(test_workspace, agent, [mine]),
            _skipped_execution(other_ws, agent, [theirs]),
        ]
    )
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert response.json() == [mine]


async def test_skipped_card_ids_dedupes_across_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    shared_card = str(uuid.uuid4())
    db_session.add_all(
        [
            _skipped_execution(test_workspace, agent, [shared_card]),
            _skipped_execution(test_workspace, agent, [shared_card]),
        ]
    )
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert response.json() == [shared_card]


async def test_skipped_card_ids_excludes_executions_older_than_the_horizon(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    stale_card = str(uuid.uuid4())
    recent_card = str(uuid.uuid4())
    now = utcnow()
    stale = _skipped_execution(test_workspace, agent, [stale_card])
    stale.started_at = now - timedelta(days=40)
    recent = _skipped_execution(test_workspace, agent, [recent_card])
    recent.started_at = now - timedelta(days=1)
    db_session.add_all([stale, recent])
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert response.json() == [recent_card]


async def test_skipped_card_ids_started_at_is_never_null(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """The horizon filter cannot be fooled by an undated row: started_at is
    declared `Mapped[datetime]` (NOT NULL) with server_default=func.now(), so
    the database rejects a NULL outright. This pins that invariant — if a future
    migration ever makes the column nullable, the horizon filter would silently
    start dropping such rows and this test fires as the reminder."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "INSERT INTO agent_executions "
                "(id, agent_id, workspace_id, action, status, input_summary, "
                " cards_affected, started_at) "
                "VALUES (:id, :agent_id, :workspace_id, 'implement', 'skipped', "
                "        'no prompt cached for stage', :cards, NULL)"
            ),
            {
                "id": str(uuid.uuid4()),
                "agent_id": str(agent.id),
                "workspace_id": str(test_workspace.id),
                "cards": json.dumps([str(uuid.uuid4())]),
            },
        )


async def test_skipped_card_ids_keeps_every_recent_card_unbounded(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """The horizon bounds the scan by recency, never by row count — a badge
    must never hide behind a page window."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    recent_cards = [str(uuid.uuid4()) for _ in range(75)]
    now = utcnow()
    for card in recent_cards:
        execution = _skipped_execution(test_workspace, agent, [card])
        execution.started_at = now - timedelta(days=2)
        db_session.add(execution)
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert sorted(response.json()) == sorted(recent_cards)


async def test_skipped_card_ids_empty_returns_empty_list(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert response.json() == []


# ---------------------------------------------------------------------------
# Filter composition inside the card_id / status=inflight scope branches.
# These branches bypass list_by_workspace's SQL filters, so agent_id/role/status
# must be applied as residual post-filters — otherwise list_executions(agent_id=A,
# status=inflight) hands back OTHER agents' running rows (dangerous straight
# before cancel_execution) and card_id+status returns the card's full history.


async def test_list_workspace_executions_card_id_composes_with_status(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card = str(uuid.uuid4())
    other_card = str(uuid.uuid4())
    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="implement", status=ExecutionStatus.completed, input_summary="x",
            completed_at=datetime(2026, 4, 1), cards_affected=[card],
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="rework", status=ExecutionStatus.failed, input_summary="x",
            completed_at=datetime(2026, 4, 2), cards_affected=[card],
        ),
        # A failed row on ANOTHER card — must not leak into the card scope.
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="other-fail", status=ExecutionStatus.failed, input_summary="x",
            completed_at=datetime(2026, 4, 3), cards_affected=[other_card],
        ),
    ])
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/executions?card_id={card}&status=failed"
    )
    assert response.status_code == 200
    data = response.json()
    assert [e["action"] for e in data] == ["rework"], (
        f"card_id+status must return only the card's failed rows, got "
        f"{[e['action'] for e in data]}"
    )


async def test_list_workspace_executions_card_id_composes_with_inflight_status(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Within the card scope, status=inflight must apply the VIRTUAL predicate
    (status in {started,running} AND completed_at IS NULL) — plain string
    equality against 'inflight' would silently match nothing."""
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card = str(uuid.uuid4())
    other_card = str(uuid.uuid4())
    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="done-stage", status=ExecutionStatus.completed, input_summary="x",
            completed_at=datetime(2026, 4, 1), cards_affected=[card],
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="active-stage", status=ExecutionStatus.running, input_summary="x",
            cards_affected=[card],
        ),
        # In-flight row on ANOTHER card — must not leak into the card scope.
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="other-active", status=ExecutionStatus.running, input_summary="x",
            cards_affected=[other_card],
        ),
    ])
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/executions?card_id={card}&status=inflight"
    )
    assert response.status_code == 200
    data = response.json()
    assert [e["action"] for e in data] == ["active-stage"], (
        f"card_id+inflight must return only the card's genuinely in-flight rows, "
        f"got {[e['action'] for e in data]}"
    )


async def test_list_workspace_executions_card_id_composes_with_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    agent_a = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    agent_b = Agent(name="reviewer", agent_type=AgentType.reviewer, created_by_id=test_user.id)
    db_session.add_all([agent_a, agent_b])
    await db_session.flush()

    card = str(uuid.uuid4())
    db_session.add_all([
        AgentExecution(
            agent_id=agent_a.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="implement", status=ExecutionStatus.completed, input_summary="x",
            cards_affected=[card],
        ),
        AgentExecution(
            agent_id=agent_b.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="review", status=ExecutionStatus.completed, input_summary="x",
            cards_affected=[card],
        ),
    ])
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/executions?card_id={card}&agent_id={agent_a.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert [e["action"] for e in data] == ["implement"]
    assert all(e["agent_id"] == str(agent_a.id) for e in data)


async def test_list_workspace_executions_inflight_composes_with_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The zombie-hunt workflow scopes by its own agent_id: inflight results must
    never include another agent's healthy running execution (the caller feeds
    rows straight into cancel_execution)."""
    agent_a = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    agent_b = Agent(name="reviewer", agent_type=AgentType.reviewer, created_by_id=test_user.id)
    db_session.add_all([agent_a, agent_b])
    await db_session.flush()

    db_session.add_all([
        AgentExecution(
            agent_id=agent_a.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="a-running", status=ExecutionStatus.running, input_summary="x",
        ),
        AgentExecution(
            agent_id=agent_a.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="a-done", status=ExecutionStatus.completed, input_summary="x",
            completed_at=datetime(2026, 4, 1),
        ),
        AgentExecution(
            agent_id=agent_b.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="b-running", status=ExecutionStatus.running, input_summary="x",
        ),
    ])
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/executions?status=inflight&agent_id={agent_a.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert [e["action"] for e in data] == ["a-running"], (
        f"inflight+agent_id must return only that agent's in-flight rows, got "
        f"{[e['action'] for e in data]}"
    )


async def test_list_workspace_executions_inflight_composes_with_role(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    db_session.add_all([
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="implementing", status=ExecutionStatus.running, input_summary="x",
            role="implement",
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
            action="reviewing", status=ExecutionStatus.running, input_summary="x",
            role="review",
        ),
    ])
    await db_session.flush()

    response = await client.get(
        "/api/workspaces/default/executions?status=inflight&role=implement"
    )
    assert response.status_code == 200
    data = response.json()
    assert [e["action"] for e in data] == ["implementing"]


# ---------------------------------------------------------------------------
# GET /api/workspaces/{slug}/executions/{execution_id}
#
# ExecutionDetailPage used to fetch the workspace's newest-50 list and .find()
# the row client-side, so any execution older than that window rendered blank.
# A detail route makes age irrelevant. Cross-workspace reads 404 rather than
# 403 so an id's existence never leaks across a tenancy boundary.
# ---------------------------------------------------------------------------


async def test_get_execution_detail_success(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement-feature",
        status=ExecutionStatus.completed,
        input_summary="Build login page",
        output_summary="Login page done",
        tool_calls_count=12,
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/executions/{execution.id}"
    )
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(execution.id)
    assert data["status"] == ExecutionStatus.completed.value
    assert data["action"] == "implement-feature"
    assert data["tool_invocations"] == []


async def test_get_execution_detail_unknown_id_404(
    client: AsyncClient,
    test_workspace: Workspace,
):
    response = await client.get(
        f"/api/workspaces/default/executions/{uuid.uuid4()}"
    )
    assert response.status_code == 404


async def test_get_execution_detail_cross_workspace_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )

    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        action="implement-feature",
        status=ExecutionStatus.completed,
        input_summary="in workspace A",
    )
    db_session.add(execution)
    await db_session.flush()

    # Same id, requested under workspace B's slug — indistinguishable from unknown.
    response = await client.get(
        f"/api/workspaces/other/executions/{execution.id}"
    )
    assert response.status_code == 404


async def test_get_execution_detail_does_not_shadow_skipped_card_ids(
    client: AsyncClient,
    test_workspace: Workspace,
):
    """The literal route must win over the {execution_id} path param — otherwise
    'skipped-card-ids' parses as a UUID path segment and 422s."""
    response = await client.get(
        "/api/workspaces/default/executions/skipped-card-ids"
    )
    assert response.status_code == 200
    assert response.json() == []
