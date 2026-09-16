# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for POST /api/agents/{agent_id}/poll — publishes agent.poll_requested on WS event bus."""
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.agents.agent import Agent
from app.models.user import User
from app.models.workspace import Workspace
from app.services.events.connection_manager import connection_manager


@pytest.mark.anyio
async def test_poll_agent_not_found(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    fake_id = uuid.uuid4()
    resp = await client.post(f"/api/agents/{fake_id}/poll")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_poll_agent_offline(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    """Agent exists but has no active WS connection — 503 with 'agent offline' detail."""
    # Ensure no connection exists for this agent
    assert connection_manager.get_connection_by_agent_id(test_agent.id) is None

    resp = await client.post(f"/api/agents/{test_agent.id}/poll")
    assert resp.status_code == 503
    data = resp.json()
    assert "agent offline" in data["detail"].lower()


@pytest.mark.anyio
async def test_poll_agent_publishes_event(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    """When a WS connection exists for the agent, service publishes agent.poll_requested."""
    from unittest.mock import AsyncMock

    from app.services.events.connection_manager import WebSocketConnection

    fake_ws = AsyncMock()
    conn = WebSocketConnection(
        websocket=fake_ws,
        workspace_id=test_workspace.id,
        user_id=test_user.id,
        agent_id=test_agent.id,
    )
    connection_manager._connections.append(conn)

    received_events = []

    async def capture_event(event):
        received_events.append(event)

    unsub = event_bus.subscribe(
        capture_event,
        workspace_id=test_workspace.id,
        event_pattern="agent.poll_requested",
    )

    try:
        resp = await client.post(f"/api/agents/{test_agent.id}/poll")
    finally:
        unsub()
        connection_manager._connections.remove(conn)

    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "poll_triggered"
    assert data["agent_id"] == str(test_agent.id)

    assert len(received_events) == 1
    event = received_events[0]
    assert event.event_type == "agent.poll_requested"
    assert event.payload == {"target_agent_id": str(test_agent.id)}
    assert event.workspace_id == test_workspace.id
