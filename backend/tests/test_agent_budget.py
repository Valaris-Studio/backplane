# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for agent budget caps (Tier 4.5 Phase 2)."""
import uuid
from datetime import timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.utils import utcnow


@pytest.mark.anyio
async def test_update_agent_budget(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
):
    resp = await client.patch(
        f"/api/agents/{test_agent.id}",
        json={"budget_usd": 50.0},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["budget_usd"] == 50.0


@pytest.mark.anyio
async def test_update_agent_budget_null(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
):
    # Set budget then clear it
    await client.patch(
        f"/api/agents/{test_agent.id}",
        json={"budget_usd": 25.0},
    )
    resp = await client.patch(
        f"/api/agents/{test_agent.id}",
        json={"budget_usd": None},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["budget_usd"] is None


@pytest.mark.anyio
async def test_get_budget_status_with_budget(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    # Set budget
    test_agent.budget_usd = 100.0
    await db_session.flush()

    # Create executions with cost
    for cost in [10.0, 15.0, 5.0]:
        execution = AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            action="implement",
            status=ExecutionStatus.completed,
            input_summary="test",
            cost_usd=cost,
            started_at=utcnow(),
        )
        db_session.add(execution)
    await db_session.flush()

    resp = await client.get(f"/api/agents/{test_agent.id}/budget-status")
    assert resp.status_code == 200
    data = resp.json()

    assert data["budget_usd"] == 100.0
    assert data["spent_usd"] == 30.0
    assert data["remaining_usd"] == 70.0
    assert data["percentage_used"] == 30.0
    assert data["is_exceeded"] is False


@pytest.mark.anyio
async def test_get_budget_status_no_budget(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    # No budget set (default None)
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="test",
        cost_usd=5.0,
        started_at=utcnow(),
    )
    db_session.add(execution)
    await db_session.flush()

    resp = await client.get(f"/api/agents/{test_agent.id}/budget-status")
    assert resp.status_code == 200
    data = resp.json()

    assert data["budget_usd"] is None
    assert data["spent_usd"] == 5.0
    assert data["remaining_usd"] is None
    assert data["percentage_used"] is None
    assert data["is_exceeded"] is False


@pytest.mark.anyio
async def test_get_budget_status_exceeded(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    # Set a low budget
    test_agent.budget_usd = 10.0
    await db_session.flush()

    # Create executions that exceed the budget
    for cost in [8.0, 5.0]:
        execution = AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            action="implement",
            status=ExecutionStatus.completed,
            input_summary="test",
            cost_usd=cost,
            started_at=utcnow(),
        )
        db_session.add(execution)
    await db_session.flush()

    resp = await client.get(f"/api/agents/{test_agent.id}/budget-status")
    assert resp.status_code == 200
    data = resp.json()

    assert data["budget_usd"] == 10.0
    assert data["spent_usd"] == 13.0
    assert data["remaining_usd"] == 0.0
    assert data["percentage_used"] == 130.0
    assert data["is_exceeded"] is True


@pytest.mark.anyio
async def test_get_budget_status_only_recent_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    """Executions older than 30 days should not count toward the budget."""
    test_agent.budget_usd = 50.0
    await db_session.flush()

    # Recent execution
    recent = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="recent",
        cost_usd=10.0,
        started_at=utcnow(),
    )
    db_session.add(recent)

    # Old execution (40 days ago)
    old = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="old",
        cost_usd=100.0,
        started_at=utcnow() - timedelta(days=40),
    )
    db_session.add(old)
    await db_session.flush()

    resp = await client.get(f"/api/agents/{test_agent.id}/budget-status")
    assert resp.status_code == 200
    data = resp.json()

    # Only the recent $10 should count
    assert data["spent_usd"] == 10.0
    assert data["remaining_usd"] == 40.0
    assert data["is_exceeded"] is False


@pytest.mark.anyio
async def test_get_budget_status_nonexistent_agent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    fake_id = uuid.uuid4()
    resp = await client.get(f"/api/agents/{fake_id}/budget-status")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_agent_read_includes_budget(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
):
    test_agent.budget_usd = 75.0
    await db_session.flush()

    resp = await client.get(f"/api/agents/{test_agent.id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["budget_usd"] == 75.0
