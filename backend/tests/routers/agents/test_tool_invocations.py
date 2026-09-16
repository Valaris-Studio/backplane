# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace


AGENTS_URL = "/api/agents"

VALID_AGENT = {
    "name": "tracker-agent",
    "agent_type": "coding",
    "description": "Agent for tool invocation tests",
    "allowed_workspaces": ["default"],
}


async def _create_agent(client: AsyncClient) -> dict:
    resp = await client.post(AGENTS_URL, json=VALID_AGENT)
    return resp.json()


async def _create_execution(client: AsyncClient, agent_id: str) -> dict:
    resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "mcp_session",
            "input_summary": "Tool invocation test session",
        },
    )
    return resp.json()


async def test_record_tool_invocations_success(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    execution = await _create_execution(client, agent["id"])

    invocations = [
        {
            "tool_name": "list_boards",
            "arguments_summary": '{"workspace_slug": "default"}',
            "result_summary": "Found 3 boards",
            "status": "completed",
            "duration_seconds": 0.15,
            "position": 0,
        },
        {
            "tool_name": "create_card",
            "arguments_summary": '{"title": "New card"}',
            "result_summary": "Card created",
            "status": "completed",
            "duration_seconds": 0.25,
            "position": 1,
        },
    ]

    response = await client.post(
        f"{AGENTS_URL}/{agent['id']}/executions/{execution['id']}/tool-invocations",
        json=invocations,
    )
    assert response.status_code == 201
    data = response.json()
    assert len(data) == 2
    assert data[0]["tool_name"] == "list_boards"
    assert data[1]["tool_name"] == "create_card"
    assert data[0]["position"] == 0
    assert data[1]["position"] == 1
    assert data[0]["status"] == "completed"


async def test_record_tool_invocations_empty_list(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    execution = await _create_execution(client, agent["id"])

    response = await client.post(
        f"{AGENTS_URL}/{agent['id']}/executions/{execution['id']}/tool-invocations",
        json=[],
    )
    assert response.status_code == 201
    assert response.json() == []


async def test_record_tool_invocations_execution_not_found(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    fake_exec_id = uuid.uuid4()

    response = await client.post(
        f"{AGENTS_URL}/{agent['id']}/executions/{fake_exec_id}/tool-invocations",
        json=[{"tool_name": "test_tool"}],
    )
    assert response.status_code == 404


async def test_record_tool_invocations_wrong_agent(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent1 = await _create_agent(client)
    execution = await _create_execution(client, agent1["id"])

    # Create a second agent
    resp = await client.post(
        AGENTS_URL,
        json={
            "name": "other-agent",
            "agent_type": "coding",
            "description": "Other",
            "allowed_workspaces": ["default"],
        },
    )
    agent2 = resp.json()

    # Try to record invocations using agent2's id but agent1's execution
    response = await client.post(
        f"{AGENTS_URL}/{agent2['id']}/executions/{execution['id']}/tool-invocations",
        json=[{"tool_name": "test_tool"}],
    )
    assert response.status_code == 404


async def test_record_tool_invocations_with_error(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    execution = await _create_execution(client, agent["id"])

    invocations = [
        {
            "tool_name": "create_card",
            "arguments_summary": '{"title": "Bad card"}',
            "status": "error",
            "error_message": "Workspace not found",
            "duration_seconds": 0.05,
            "position": 0,
        },
    ]

    response = await client.post(
        f"{AGENTS_URL}/{agent['id']}/executions/{execution['id']}/tool-invocations",
        json=invocations,
    )
    assert response.status_code == 201
    data = response.json()
    assert data[0]["status"] == "error"
    assert data[0]["error_message"] == "Workspace not found"


async def test_execution_read_includes_tool_invocations(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    execution = await _create_execution(client, agent["id"])

    # Record some invocations
    await client.post(
        f"{AGENTS_URL}/{agent['id']}/executions/{execution['id']}/tool-invocations",
        json=[
            {"tool_name": "list_boards", "status": "completed", "position": 0},
            {"tool_name": "create_card", "status": "completed", "position": 1},
        ],
    )

    # List executions and verify invocations are nested
    response = await client.get(f"{AGENTS_URL}/{agent['id']}/executions")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert len(data[0]["tool_invocations"]) == 2
    assert data[0]["tool_invocations"][0]["tool_name"] == "list_boards"
    assert data[0]["tool_invocations"][1]["tool_name"] == "create_card"


async def test_execution_read_empty_invocations_by_default(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    execution = await _create_execution(client, agent["id"])

    response = await client.get(f"{AGENTS_URL}/{agent['id']}/executions")
    assert response.status_code == 200
    data = response.json()
    assert data[0]["tool_invocations"] == []


async def test_record_tool_invocations_non_owner_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    other_agent = Agent(
        name="other-owners-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    execution = AgentExecution(
        agent_id=other_agent.id,
        workspace_id=test_workspace.id,
        action="private",
        status=ExecutionStatus.started,
        input_summary="Private execution",
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.post(
        f"{AGENTS_URL}/{other_agent.id}/executions/{execution.id}/tool-invocations",
        json=[{"tool_name": "spoof_tool", "status": "completed", "position": 0}],
    )
    assert response.status_code == 404


async def test_record_tool_invocations_accepts_tz_aware_timestamps(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    # Regression: MCP tracker sends tz-aware UTC timestamps; on Postgres this
    # hit asyncpg's "can't compare offset-naive and offset-aware datetimes"
    # or TIMESTAMP-without-tz coercion error, producing continuous 500s on
    # POST .../tool-invocations and leaving every execution with an empty
    # tool_invocations list. Service must normalize to naive UTC before
    # reaching the repository so the column type (TIMESTAMP WITHOUT TZ) is
    # respected on both backends.
    agent = await _create_agent(client)
    execution = await _create_execution(client, agent["id"])

    started = datetime(2026, 4, 17, 12, 0, 0, tzinfo=timezone.utc)
    completed = datetime(2026, 4, 17, 12, 0, 5, tzinfo=timezone.utc)

    response = await client.post(
        f"{AGENTS_URL}/{agent['id']}/executions/{execution['id']}/tool-invocations",
        json=[
            {
                "tool_name": "list_boards",
                "arguments_summary": "{}",
                "status": "completed",
                "started_at": started.isoformat(),
                "completed_at": completed.isoformat(),
                "duration_seconds": 5.0,
                "position": 0,
            }
        ],
    )
    assert response.status_code == 201
    data = response.json()
    assert len(data) == 1
    assert data[0]["tool_name"] == "list_boards"
