# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.utils import utcnow


BASE = "/api/workspaces/default/metrics"


async def test_execution_analytics_empty(
    client: AsyncClient, test_workspace: Workspace
):
    """No executions returns all zeros and empty daily_metrics."""
    response = await client.get(f"{BASE}/execution-analytics")
    assert response.status_code == 200
    data = response.json()
    assert data["daily_metrics"] == []
    assert data["total_executions"] == 0
    assert data["total_completed"] == 0
    assert data["total_failed"] == 0
    assert data["total_cost_usd"] == 0.0
    assert data["success_rate"] == 0.0
    assert data["rework_rate"] == 0.0
    assert data["avg_duration_seconds"] == 0.0
    assert data["avg_cost_per_card"] == 0.0


async def test_execution_analytics_with_data(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Create executions across 2 days, verify aggregation logic."""
    agent = Agent(
        name="Builder",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
    )
    db_session.add(agent)
    await db_session.flush()

    now = utcnow()
    today = now.replace(hour=12, minute=0, second=0, microsecond=0)
    yesterday = today - timedelta(days=1)

    card_a = str(uuid.uuid4())
    card_b = str(uuid.uuid4())

    # Today: 2 completed, 1 failed, 1 rework
    executions = [
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="implement", status=ExecutionStatus.completed,
            started_at=today, duration_seconds=120.0,
            cost_usd=0.50, tokens_used=500, input_summary="impl",
            cards_affected=[card_a],
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="implement", status=ExecutionStatus.completed,
            started_at=today, duration_seconds=60.0,
            cost_usd=0.30, tokens_used=300, input_summary="impl",
            cards_affected=[card_b],
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="implement", status=ExecutionStatus.failed,
            started_at=today, duration_seconds=10.0,
            cost_usd=0.10, tokens_used=100, input_summary="fail",
        ),
        AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="rework-card", status=ExecutionStatus.completed,
            started_at=today, duration_seconds=30.0,
            cost_usd=0.20, tokens_used=200, input_summary="rework",
            cards_affected=[card_a],
        ),
    ]
    # Yesterday: 1 completed
    executions.append(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="implement", status=ExecutionStatus.completed,
        started_at=yesterday, duration_seconds=90.0,
        cost_usd=0.40, tokens_used=400, input_summary="impl",
        cards_affected=[card_b],
    ))
    db_session.add_all(executions)
    await db_session.flush()

    response = await client.get(f"{BASE}/execution-analytics")
    assert response.status_code == 200
    data = response.json()

    # Totals across all 5 executions
    assert data["total_executions"] == 5
    assert data["total_completed"] == 4  # 3 impl + 1 rework
    assert data["total_failed"] == 1
    assert data["total_cost_usd"] == pytest.approx(1.50, abs=0.01)

    # success_rate = completed / (completed + failed) = 4/5 = 0.8
    assert data["success_rate"] == pytest.approx(0.8, abs=0.01)

    # rework_rate = 1 rework / 5 total = 0.2
    assert data["rework_rate"] == pytest.approx(0.2, abs=0.01)

    # avg_duration = (120+60+10+30+90) / 5 = 62.0
    assert data["avg_duration_seconds"] == pytest.approx(62.0, abs=0.1)

    # avg_cost_per_card: total_cost / unique cards affected
    # cards_affected: card_a (2 times), card_b (2 times) => 2 unique cards
    # avg_cost = 1.50 / 2 = 0.75
    assert data["avg_cost_per_card"] == pytest.approx(0.75, abs=0.01)

    # daily_metrics should have 2 entries (today + yesterday)
    assert len(data["daily_metrics"]) == 2
    # Sorted by date ascending
    metrics_by_date = {m["date"]: m for m in data["daily_metrics"]}
    yesterday_str = yesterday.strftime("%Y-%m-%d")
    today_str = today.strftime("%Y-%m-%d")

    assert yesterday_str in metrics_by_date
    assert today_str in metrics_by_date

    yd = metrics_by_date[yesterday_str]
    assert yd["executions"] == 1
    assert yd["cards_completed"] == 1
    assert yd["failures"] == 0
    assert yd["cost_usd"] == pytest.approx(0.40, abs=0.01)

    td = metrics_by_date[today_str]
    assert td["executions"] == 4
    assert td["cards_completed"] == 3  # 2 impl completed + 1 rework completed
    assert td["failures"] == 1
    assert td["cost_usd"] == pytest.approx(1.10, abs=0.01)


async def test_execution_analytics_filter_by_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """agent_id query param filters to only that agent's executions."""
    agent_a = Agent(
        name="Alpha", agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
    )
    agent_b = Agent(
        name="Beta", agent_type=AgentType.reviewer,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
    )
    db_session.add_all([agent_a, agent_b])
    await db_session.flush()

    now = utcnow()

    # 2 executions for agent_a
    db_session.add(AgentExecution(
        agent_id=agent_a.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now, duration_seconds=50.0,
        cost_usd=0.25, tokens_used=250, input_summary="a1",
    ))
    db_session.add(AgentExecution(
        agent_id=agent_a.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.failed,
        started_at=now, duration_seconds=15.0,
        cost_usd=0.05, tokens_used=50, input_summary="a2",
    ))
    # 1 execution for agent_b
    db_session.add(AgentExecution(
        agent_id=agent_b.id, workspace_id=test_workspace.id,
        action="review", status=ExecutionStatus.completed,
        started_at=now, duration_seconds=30.0,
        cost_usd=0.10, tokens_used=100, input_summary="b1",
    ))
    await db_session.flush()

    # Without filter: all 3
    response = await client.get(f"{BASE}/execution-analytics")
    assert response.status_code == 200
    assert response.json()["total_executions"] == 3

    # Filter by agent_a: only 2
    response = await client.get(
        f"{BASE}/execution-analytics", params={"agent_id": str(agent_a.id)}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["total_executions"] == 2
    assert data["total_completed"] == 1
    assert data["total_failed"] == 1
    assert data["total_cost_usd"] == pytest.approx(0.30, abs=0.01)
    assert data["success_rate"] == pytest.approx(0.5, abs=0.01)

    # Filter by agent_b: only 1
    response = await client.get(
        f"{BASE}/execution-analytics", params={"agent_id": str(agent_b.id)}
    )
    assert response.status_code == 200
    data = response.json()
    assert data["total_executions"] == 1
    assert data["total_completed"] == 1
    assert data["total_failed"] == 0
    assert data["success_rate"] == pytest.approx(1.0, abs=0.01)


async def test_execution_analytics_days_param(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """days param limits the lookback window."""
    agent = Agent(
        name="Worker", agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
    )
    db_session.add(agent)
    await db_session.flush()

    now = utcnow()

    # Execution 3 days ago
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now - timedelta(days=3), duration_seconds=20.0,
        cost_usd=0.10, tokens_used=100, input_summary="recent",
    ))
    # Execution 10 days ago
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="code", status=ExecutionStatus.completed,
        started_at=now - timedelta(days=10), duration_seconds=20.0,
        cost_usd=0.10, tokens_used=100, input_summary="old",
    ))
    await db_session.flush()

    # days=7 should only include the recent one
    response = await client.get(
        f"{BASE}/execution-analytics", params={"days": 7}
    )
    assert response.status_code == 200
    assert response.json()["total_executions"] == 1

    # days=30 should include both
    response = await client.get(
        f"{BASE}/execution-analytics", params={"days": 30}
    )
    assert response.status_code == 200
    assert response.json()["total_executions"] == 2


async def test_execution_analytics_nonexistent_workspace(client: AsyncClient):
    """Nonexistent workspace returns 404."""
    response = await client.get(
        "/api/workspaces/nonexistent/metrics/execution-analytics"
    )
    assert response.status_code == 404


async def test_execution_analytics_role_distribution(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """role_distribution counts EVERY execution in the window, grouped by role.

    Regression: the frontend used to aggregate roles client-side over a
    backend-capped 50-row /executions window, so any workspace with more
    executions undercounted. The count must be computed server-side over the
    full window.

    Role-less rows are NON-pipeline executions (standup, mcp_session, ad-hoc) —
    the runner always threads a role for card work. Bucketing them all as one
    opaque "unknown" was misleading ("most of the chart is unassigned"). Instead
    label each by its action, prefixed `action:` so the frontend can tell an
    action-derived label from a pipeline role and translate accordingly.
    """
    agent = Agent(
        name="Worker", agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
    )
    db_session.add(agent)
    await db_session.flush()

    now = utcnow()

    def mk(role, action="work", status=ExecutionStatus.completed):
        return AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action=action, role=role, status=status,
            started_at=now, duration_seconds=10.0,
            cost_usd=0.01, tokens_used=10, input_summary="x",
        )

    db_session.add_all(
        [mk("implementer") for _ in range(3)]
        + [mk("reviewer") for _ in range(2)]
        + [mk("ui_validator")]
        + [mk(None, action="standup") for _ in range(2)]  # non-pipeline → action:standup
        + [mk(None, action="mcp_session")]  # non-pipeline → action:mcp_session
    )
    await db_session.flush()

    response = await client.get(f"{BASE}/execution-analytics")
    assert response.status_code == 200
    data = response.json()

    dist = {row["role"]: row["count"] for row in data["role_distribution"]}
    assert dist["implementer"] == 3
    assert dist["reviewer"] == 2
    assert dist["ui_validator"] == 1
    # Role-less rows broken out by action, NOT lumped into one "unknown" bucket.
    assert dist["action:standup"] == 2
    assert dist["action:mcp_session"] == 1
    assert "unknown" not in dist
    # Sum of the distribution must equal total executions — nothing dropped.
    assert sum(dist.values()) == data["total_executions"] == 9
