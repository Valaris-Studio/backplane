# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.utils import utcnow
from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/metrics"


# ---------- /agents ----------

async def test_get_agent_metrics_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    data = response.json()
    assert data["agents"] == []


async def test_get_agent_metrics_with_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(
        name="Builder",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
    )
    db_session.add(agent)
    await db_session.flush()

    now = utcnow()

    # 2 completed, 1 failed
    for status, duration, tokens, cost in [
        (ExecutionStatus.completed, 10.0, 500, 0.50),
        (ExecutionStatus.completed, 20.0, 300, 0.30),
        (ExecutionStatus.failed, 5.0, 100, 0.10),
    ]:
        db_session.add(AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            action="build",
            status=status,
            started_at=now,
            completed_at=now + timedelta(seconds=int(duration)),
            duration_seconds=duration,
            tokens_used=tokens,
            cost_usd=cost,
            input_summary="test",
        ))
    await db_session.flush()

    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    data = response.json()
    assert len(data["agents"]) == 1
    a = data["agents"][0]
    assert a["agent_id"] is not None
    assert a["name"] == "Builder"
    assert a["agent_type"] == "coding"
    assert a["total_executions"] == 3
    assert a["completed_executions"] == 2
    assert a["failed_executions"] == 1
    assert a["avg_duration_seconds"] == pytest.approx(11.67, abs=0.01)
    assert a["total_tokens_used"] == 900
    # Cost is summed across ALL executions (completed + failed).
    assert a["total_cost_usd"] == pytest.approx(0.90, abs=0.01)


async def test_agent_metrics_expose_current_board_for_working_card_link(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # A working agent's current card carries its board so the UI can deep-link it.
    board_id = uuid.uuid4()
    agent = Agent(
        name="Builder",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        health_status="working",
        health_current_card_id=str(uuid.uuid4()),
        health_current_board_id=str(board_id),
        last_seen_at=utcnow(),
    )
    db_session.add(agent)
    await db_session.flush()

    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    a = response.json()["agents"][0]
    assert a["health_current_board_id"] == str(board_id)


async def test_agent_metrics_include_inactive_returns_deactivated(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """include_inactive=true surfaces deactivated runners so operators can reactivate them.

    Default (active-only) call should omit inactive runners; the flagged call
    must include them with `is_active: false`.
    """
    active = Agent(
        name="ActiveBot",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=True,
    )
    inactive = Agent(
        name="DeadBot",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=False,
    )
    db_session.add_all([active, inactive])
    await db_session.flush()

    default_response = await client.get(f"{BASE}/agents")
    assert default_response.status_code == 200
    default_names = {a["name"] for a in default_response.json()["agents"]}
    assert default_names == {"ActiveBot"}

    with_inactive = await client.get(f"{BASE}/agents?include_inactive=true")
    assert with_inactive.status_code == 200
    rows = with_inactive.json()["agents"]
    assert {a["name"] for a in rows} == {"ActiveBot", "DeadBot"}
    by_name = {a["name"]: a for a in rows}
    assert by_name["ActiveBot"]["is_active"] is True
    assert by_name["DeadBot"]["is_active"] is False


async def test_agent_metrics_expose_is_paused(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """The runners list must be able to render Paused without a per-row detail fetch.

    is_paused lives on the Agent row (pause primitive, card 49f8bb82) but was
    never projected into the metrics payload, so the runners table could not
    distinguish a paused runner from an idle one — the operator-safety gap this
    card exists to close.
    """
    running = Agent(
        name="RunningBot",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_paused=False,
    )
    paused = Agent(
        name="PausedBot",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_paused=True,
    )
    db_session.add_all([running, paused])
    await db_session.flush()

    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    by_name = {a["name"]: a for a in response.json()["agents"]}
    assert by_name["RunningBot"]["is_paused"] is False
    assert by_name["PausedBot"]["is_paused"] is True


async def test_get_agent_metrics_multiple_agents(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent_a = Agent(name="Alpha", agent_type=AgentType.coding, created_by_id=test_user.id, allowed_workspaces=[test_workspace.slug])
    agent_b = Agent(name="Beta", agent_type=AgentType.reviewer, created_by_id=test_user.id, allowed_workspaces=[test_workspace.slug])
    db_session.add_all([agent_a, agent_b])
    await db_session.flush()

    now = utcnow()
    db_session.add(AgentExecution(
        agent_id=agent_a.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now, duration_seconds=5.0, tokens_used=100, input_summary="x",
    ))
    db_session.add(AgentExecution(
        agent_id=agent_b.id, workspace_id=test_workspace.id,
        action="review", status=ExecutionStatus.completed,
        started_at=now, duration_seconds=8.0, tokens_used=200, input_summary="y",
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    names = {a["name"] for a in response.json()["agents"]}
    assert names == {"Alpha", "Beta"}


async def test_agent_metrics_inflight_promotes_stale_heartbeat_to_working(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """An agent mid-stage heartbeats only at stage boundaries, so during a long
    LLM stage last_seen_at ages past the 90s alive threshold → 'stale'. But it
    HAS an in-flight execution, so it is working. The metrics endpoint must
    promote it: working=true and liveness='alive', not 'stale'. This is the
    exact live scenario where the board falsely read '0 working / Stale'."""
    agent = Agent(
        name="jamssen-runner",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        last_seen_at=utcnow() - timedelta(minutes=5),  # stale by heartbeat alone
    )
    db_session.add(agent)
    await db_session.flush()

    # A genuinely in-flight execution: running, completed_at IS NULL.
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id, board_id=test_board.id,
        action="implement_card", status=ExecutionStatus.running,
        started_at=utcnow(), input_summary="working A4",
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    a = response.json()["agents"][0]
    assert a["working"] is True, "in-flight execution => working"
    assert a["liveness"] == "alive", (
        f"in-flight execution must promote liveness above 'stale', got {a['liveness']}"
    )


async def test_agent_metrics_no_inflight_keeps_heartbeat_liveness(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """No in-flight execution => liveness stays heartbeat-derived and working is
    false. A truly idle/dead runner must still read stale/offline (the promotion
    must not mask a genuinely gone runner)."""
    agent = Agent(
        name="idle-runner",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        last_seen_at=utcnow() - timedelta(minutes=5),  # stale
    )
    db_session.add(agent)
    await db_session.flush()

    response = await client.get(f"{BASE}/agents")
    assert response.status_code == 200
    a = response.json()["agents"][0]
    assert a["working"] is False
    assert a["liveness"] == "stale"


# ---------- /velocity ----------

async def test_get_velocity_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE}/velocity")
    assert response.status_code == 200
    data = response.json()
    assert data["cards_completed_7d"] == 0
    assert data["cards_completed_30d"] == 0
    assert data["cards_completed_90d"] == 0


async def test_get_velocity_counts_moves_to_last_column(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    col_todo = Column(board_id=test_board.id, name="To Do", position=1024.0)
    col_done = Column(board_id=test_board.id, name="Done", position=2048.0)
    db_session.add_all([col_todo, col_done])
    await db_session.flush()

    now = utcnow()

    # 1 move to done 3 days ago
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.moved,
        summary="Moved card to Done",
        changes={
            "column_id": {"old": str(col_todo.id), "new": str(col_done.id)},
            "from_column": "To Do", "to_column": "Done",
        },
        created_at=now - timedelta(days=3),
    ))

    # 1 move to done 20 days ago
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.moved,
        summary="Moved card to Done",
        changes={
            "column_id": {"old": str(col_todo.id), "new": str(col_done.id)},
            "from_column": "To Do", "to_column": "Done",
        },
        created_at=now - timedelta(days=20),
    ))

    # 1 move to todo (should NOT count)
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.moved,
        summary="Moved card to To Do",
        changes={
            "column_id": {"old": str(col_done.id), "new": str(col_todo.id)},
            "from_column": "Done", "to_column": "To Do",
        },
        created_at=now - timedelta(days=1),
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/velocity")
    assert response.status_code == 200
    data = response.json()
    assert data["cards_completed_7d"] == 1
    assert data["cards_completed_30d"] == 2
    assert data["cards_completed_90d"] == 2


# ---------- /quality ----------

async def test_get_quality_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE}/quality")
    assert response.status_code == 200
    data = response.json()
    assert data["reversion_rate"] is None
    assert data["agent_efficiency_score"] is None


async def test_get_quality_with_data(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    col_todo = Column(board_id=test_board.id, name="To Do", position=1024.0)
    col_progress = Column(board_id=test_board.id, name="In Progress", position=2048.0)
    col_done = Column(board_id=test_board.id, name="Done", position=3072.0)
    db_session.add_all([col_todo, col_progress, col_done])
    await db_session.flush()

    now = utcnow()

    # 3 forward moves + 1 backward move => reversion_rate = 1/4 = 0.25
    for to_col, from_col in [
        (col_progress.id, col_todo.id),
        (col_done.id, col_progress.id),
        (col_done.id, col_progress.id),
        (col_todo.id, col_progress.id),  # backward
    ]:
        db_session.add(Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.moved,
            summary="Moved",
            changes={
                "column_id": {"old": str(from_col), "new": str(to_col)},
                "from_column": "src", "to_column": "dst",
            },
            created_at=now - timedelta(days=1),
        ))

    # Agent executions: 3 completed, 1 failed => efficiency = 0.75
    agent = Agent(name="Bot", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    for status in [
        ExecutionStatus.completed,
        ExecutionStatus.completed,
        ExecutionStatus.completed,
        ExecutionStatus.failed,
    ]:
        db_session.add(AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            action="work",
            status=status,
            started_at=now,
            input_summary="test",
        ))
    await db_session.flush()

    response = await client.get(f"{BASE}/quality")
    assert response.status_code == 200
    data = response.json()
    assert data["reversion_rate"] == pytest.approx(0.25, abs=0.01)
    assert data["agent_efficiency_score"] == pytest.approx(0.75, abs=0.01)


# ---------- /cost ----------

async def test_get_cost_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE}/cost")
    assert response.status_code == 200
    assert response.json() == {"agents": []}


async def test_get_cost_with_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="Coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    now = utcnow()

    # Recent execution (within 7d)
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now - timedelta(days=2), tokens_used=1000, input_summary="a",
    ))
    # Older execution (within 30d but not 7d)
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now - timedelta(days=15), tokens_used=2000, input_summary="b",
    ))
    # Very old execution (beyond 30d — should not count)
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now - timedelta(days=45), tokens_used=5000, input_summary="c",
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/cost")
    assert response.status_code == 200
    data = response.json()
    assert len(data["agents"]) == 1
    a = data["agents"][0]
    assert a["name"] == "Coder"
    assert a["tokens_used_7d"] == 1000
    assert a["tokens_used_30d"] == 3000
    assert a["executions_7d"] == 1
    assert a["executions_30d"] == 2


# ---------- /card-costs ----------

async def test_get_card_costs_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{BASE}/card-costs")
    assert response.status_code == 200
    assert response.json() == {"cards": []}


async def test_get_card_costs_single_execution(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="Bot", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card_a = str(uuid.uuid4())
    card_b = str(uuid.uuid4())

    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=utcnow(), input_summary="test",
        cost_usd=1.0, tokens_used=1000,
        cards_affected=[card_a, card_b],
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/card-costs")
    assert response.status_code == 200
    data = response.json()
    assert len(data["cards"]) == 2
    # Cost split evenly: 0.50 each, tokens 500 each
    costs_by_id = {c["card_id"]: c for c in data["cards"]}
    assert costs_by_id[card_a]["total_cost_usd"] == 0.5
    assert costs_by_id[card_a]["total_tokens"] == 500
    assert costs_by_id[card_a]["execution_count"] == 1
    assert costs_by_id[card_b]["total_cost_usd"] == 0.5
    assert costs_by_id[card_b]["total_tokens"] == 500
    assert costs_by_id[card_b]["execution_count"] == 1


async def test_get_card_costs_multiple_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="Bot", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card_a = str(uuid.uuid4())
    card_b = str(uuid.uuid4())
    now = utcnow()

    # Execution 1: affects card_a only, cost=0.30, tokens=300
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now, input_summary="test",
        cost_usd=0.30, tokens_used=300,
        cards_affected=[card_a],
    ))
    # Execution 2: affects both cards, cost=1.00, tokens=1000
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now, input_summary="test",
        cost_usd=1.00, tokens_used=1000,
        cards_affected=[card_a, card_b],
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/card-costs")
    assert response.status_code == 200
    data = response.json()
    costs_by_id = {c["card_id"]: c for c in data["cards"]}

    # card_a: 0.30 + 0.50 = 0.80, tokens: 300 + 500 = 800, exec_count: 2
    assert costs_by_id[card_a]["total_cost_usd"] == 0.8
    assert costs_by_id[card_a]["total_tokens"] == 800
    assert costs_by_id[card_a]["execution_count"] == 2
    # card_b: 0.50, tokens: 500, exec_count: 1
    assert costs_by_id[card_b]["total_cost_usd"] == 0.5
    assert costs_by_id[card_b]["total_tokens"] == 500
    assert costs_by_id[card_b]["execution_count"] == 1
    # Sorted by cost desc — card_a first
    assert data["cards"][0]["card_id"] == card_a


async def test_get_card_costs_null_cost_and_tokens(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Executions with null cost_usd/tokens_used contribute 0."""
    agent = Agent(name="Bot", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card_a = str(uuid.uuid4())
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=utcnow(), input_summary="test",
        cost_usd=None, tokens_used=None,
        cards_affected=[card_a],
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/card-costs")
    assert response.status_code == 200
    data = response.json()
    assert len(data["cards"]) == 1
    assert data["cards"][0]["total_cost_usd"] == 0.0
    assert data["cards"][0]["total_tokens"] == 0
    assert data["cards"][0]["execution_count"] == 1


async def test_get_card_costs_ignores_other_workspace(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Only counts executions from the requested workspace."""
    agent = Agent(name="Bot", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()

    card_a = str(uuid.uuid4())
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=other_ws.id,
        action="code", status=ExecutionStatus.completed,
        started_at=utcnow(), input_summary="test",
        cost_usd=5.0, tokens_used=5000,
        cards_affected=[card_a],
    ))
    await db_session.flush()

    response = await client.get(f"{BASE}/card-costs")
    assert response.status_code == 200
    assert response.json() == {"cards": []}


# ---------- auth / workspace ----------

async def test_metrics_nonexistent_workspace(client: AsyncClient):
    response = await client.get("/api/workspaces/nonexistent/metrics/agents")
    assert response.status_code == 404
