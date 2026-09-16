# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for the two destructive agent lifecycle endpoints.

POST /api/agents/{id}/restart  — publishes agent.restart_requested on the workspace WS.
DELETE /api/agents/{id}/hard   — true row delete, refused while a card is in flight.
"""
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.agents.agent import Agent, AgentType
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.approvals.approval import ApprovalCategory, ApprovalRequest
from app.models.user import User
from app.schemas.agents.agent import HeartbeatBody
from app.models.workspace import Workspace
from app.services.agents.liveness import ALIVE_THRESHOLD_SECONDS
from app.services.events.connection_manager import WebSocketConnection, connection_manager
from app.utils import utcnow


def _connect(test_workspace: Workspace, test_user: User, test_agent: Agent) -> WebSocketConnection:
    conn = WebSocketConnection(
        websocket=AsyncMock(),
        workspace_id=test_workspace.id,
        user_id=test_user.id,
        agent_id=test_agent.id,
    )
    connection_manager._connections.append(conn)
    return conn


@pytest.mark.anyio
async def test_restart_agent_not_found(client: AsyncClient, test_user: User):
    resp = await client.post(f"/api/agents/{uuid.uuid4()}/restart")
    assert resp.status_code == 404


@pytest.mark.anyio
async def test_restart_agent_offline(
    client: AsyncClient, test_user: User, test_agent: Agent
):
    """No live WS connection means nothing can receive the command — 503, not a silent 200."""
    assert connection_manager.get_connection_by_agent_id(test_agent.id) is None

    resp = await client.post(f"/api/agents/{test_agent.id}/restart")
    assert resp.status_code == 503
    assert "agent offline" in resp.json()["detail"].lower()


@pytest.mark.anyio
async def test_restart_agent_heartbeating_without_connection_is_not_reported_offline(
    client: AsyncClient, test_user: User, test_agent: Agent, db_session: AsyncSession
):
    """A loop-mode runner heartbeats but never opens the events WS.

    Calling it "offline" is a lie an operator acts on (restart the box, check
    the network) while the process is actively burning iterations. The honest
    condition is: alive, but no control channel to receive the command.
    """
    test_agent.last_seen_at = utcnow()
    await db_session.flush()
    assert connection_manager.get_connection_by_agent_id(test_agent.id) is None

    resp = await client.post(f"/api/agents/{test_agent.id}/restart")

    assert resp.status_code == 409
    body = resp.json()
    assert body["error_code"] == "no_control_channel"
    assert "offline" not in body["detail"].lower()
    assert "pipeline" in body["detail"].lower()


@pytest.mark.anyio
async def test_restart_agent_stale_heartbeat_is_still_offline(
    client: AsyncClient, test_user: User, test_agent: Agent, db_session: AsyncSession
):
    """Past the alive threshold the process is presumed gone — "offline" is honest again."""
    test_agent.last_seen_at = utcnow() - timedelta(seconds=ALIVE_THRESHOLD_SECONDS + 60)
    await db_session.flush()

    resp = await client.post(f"/api/agents/{test_agent.id}/restart")

    assert resp.status_code == 503
    assert "agent offline" in resp.json()["detail"].lower()


@pytest.mark.anyio
async def test_restart_agent_publishes_event(
    client: AsyncClient,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    conn = _connect(test_workspace, test_user, test_agent)
    received = []

    async def capture(event):
        received.append(event)

    unsub = event_bus.subscribe(
        capture, workspace_id=test_workspace.id, event_pattern="agent.restart_requested"
    )
    try:
        resp = await client.post(f"/api/agents/{test_agent.id}/restart")
    finally:
        unsub()
        connection_manager._connections.remove(conn)

    assert resp.status_code == 200
    assert resp.json()["status"] == "restart_requested"
    assert len(received) == 1
    assert received[0].payload["target_agent_id"] == str(test_agent.id)


@pytest.mark.anyio
async def test_hard_delete_refuses_while_card_in_flight(
    client: AsyncClient, db_session: AsyncSession, test_user: User, test_agent: Agent
):
    """A runner mid-card would lose its claim silently — refuse with 409 instead."""
    test_agent.health_current_card_id = str(uuid.uuid4())
    await db_session.flush()

    resp = await client.delete(f"/api/agents/{test_agent.id}/hard")
    assert resp.status_code == 409

    still_there = await db_session.get(Agent, test_agent.id)
    assert still_there is not None


@pytest.mark.anyio
async def test_hard_delete_removes_row_and_cascades(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    """Idle runner: the row goes, and the rows that only exist to describe it go with it."""
    team = AgentTeam(name="t", slug="t", workspace_id=test_workspace.id, created_by_id=test_user.id)
    db_session.add(team)
    await db_session.flush()
    db_session.add(AgentTeamMember(team_id=team.id, agent_id=test_agent.id, roles=["coding"]))
    db_session.add(
        ApprovalRequest(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            category=ApprovalCategory.deletion,
            action_description="pending work",
            # server_default is a Postgres interval expression; SQLite needs a value.
            expires_at=utcnow() + timedelta(hours=24),
        )
    )
    await db_session.flush()

    resp = await client.delete(f"/api/agents/{test_agent.id}/hard")
    assert resp.status_code == 204

    assert await db_session.get(Agent, test_agent.id) is None
    approvals = (
        await db_session.execute(
            select(ApprovalRequest).where(ApprovalRequest.agent_id == test_agent.id)
        )
    ).scalars().all()
    assert approvals == []
    members = (
        await db_session.execute(
            select(AgentTeamMember).where(AgentTeamMember.agent_id == test_agent.id)
        )
    ).scalars().all()
    assert members == []


@pytest.mark.anyio
async def test_hard_delete_is_idempotent(
    client: AsyncClient, db_session: AsyncSession, test_user: User, test_agent: Agent
):
    """Retrying a delete that already succeeded is success, never 404 (idempotent mutations)."""
    first = await client.delete(f"/api/agents/{test_agent.id}/hard")
    assert first.status_code == 204

    second = await client.delete(f"/api/agents/{test_agent.id}/hard")
    assert second.status_code == 204


@pytest.mark.anyio
async def test_hard_delete_other_user_agent_returns_404_and_keeps_the_row(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_user: User,
):
    """A stranger's agent answers 404, not the 204 that means "it's gone".

    Idempotency covers a RETRY of your own delete; folding "not yours" into the
    same silent success told the caller their delete landed while the agent
    lived on. 404 (not 403) matches deactivate_agent and the execution
    endpoints: a stranger cannot use the response to probe which agent ids
    exist.
    """
    other_agent = Agent(
        name="user-b-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    resp = await client.delete(f"/api/agents/{other_agent.id}/hard")
    assert resp.status_code == 404

    assert await db_session.get(Agent, other_agent.id) is not None


@pytest.mark.anyio
async def test_heartbeat_body_normalizes_blank_current_card_id_to_none():
    """"" is not a card id. It is falsy, so it reads as "no card" in the
    mid-card delete guard while still occupying the column — garbage that other
    branches silently trust.

    Normalized rather than rejected: both transports parse through this model,
    and on the WS path a ValidationError is caught and logged (events.py), which
    would drop the whole frame — so a stray "" would stop last_seen_at from
    advancing and drift a healthy runner toward "offline". Blanking the field is
    strictly safer than losing the liveness signal.
    """
    body = HeartbeatBody.model_validate({"status": "working", "current_card_id": ""})
    assert body.current_card_id is None

    assert HeartbeatBody.model_validate({"current_card_id": "   "}).current_card_id is None
    assert HeartbeatBody.model_validate({"current_board_id": ""}).current_board_id is None


@pytest.mark.anyio
async def test_heartbeat_blank_current_card_id_does_not_reach_the_column(
    client: AsyncClient, db_session: AsyncSession, test_agent: Agent, agent_client: AsyncClient
):
    """End-to-end: a blank id leaves the column untouched, and the beat still lands."""
    test_agent.health_current_card_id = None
    await db_session.flush()

    resp = await agent_client.post(
        "/api/agents/me/heartbeat",
        json={"status": "working", "current_card_id": ""},
    )
    assert resp.status_code == 200

    await db_session.refresh(test_agent)
    assert test_agent.health_current_card_id is None
    assert test_agent.last_seen_at is not None


@pytest.mark.anyio
async def test_heartbeat_still_accepts_a_real_current_card_id(
    client: AsyncClient, db_session: AsyncSession, test_agent: Agent, agent_client: AsyncClient
):
    """The validator must not cost the runner its normal working heartbeat."""
    card_id = str(uuid.uuid4())
    resp = await agent_client.post(
        "/api/agents/me/heartbeat",
        json={"status": "working", "current_card_id": card_id},
    )
    assert resp.status_code == 200

    await db_session.refresh(test_agent)
    assert test_agent.health_current_card_id == card_id


@pytest.mark.anyio
async def test_hard_delete_publishes_event(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
):
    test_agent.allowed_workspaces = [str(test_workspace.id)]
    await db_session.flush()

    received = []

    async def capture(event):
        received.append(event)

    unsub = event_bus.subscribe(
        capture, workspace_id=test_workspace.id, event_pattern="agent.hard_deleted"
    )
    try:
        resp = await client.delete(f"/api/agents/{test_agent.id}/hard")
    finally:
        unsub()

    assert resp.status_code == 204
    assert len(received) == 1
    assert received[0].payload["agent_id"] == str(test_agent.id)
