# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace


async def test_improvement_status_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get("/api/workspaces/default/improvement/status")
    assert response.status_code == 200
    data = response.json()
    assert data["triggers"] == []
    assert data["improvements_today"] == 0
    assert data["can_run"] is True


async def test_improvement_status_with_failures(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="flaky", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    for _ in range(3):
        db_session.add(AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="deploy", status=ExecutionStatus.failed,
        ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/improvement/status")
    assert response.status_code == 200
    data = response.json()
    assert len(data["triggers"]) >= 1
    assert any(t["trigger_type"] == "repeated_failure" for t in data["triggers"])


async def test_improvement_status_rate_limited(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = Agent(name="improver", agent_type=AgentType.improver, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    for _ in range(3):
        db_session.add(AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="self_improvement", status=ExecutionStatus.completed,
        ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/improvement/status")
    assert response.status_code == 200
    data = response.json()
    assert data["improvements_today"] == 3
    assert data["can_run"] is False
