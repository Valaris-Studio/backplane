# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Restart must reach a runner whose WS lives on a DIFFERENT gunicorn worker.

`connection_manager` is a per-process singleton; the event bus is Postgres
LISTEN/NOTIFY and crosses processes. Under `--workers N` a restart POST lands on
an arbitrary worker, so consulting the local registry answers "no control
channel" for ~(N-1)/N of requests against a runner that demonstrably has one.

These tests model the two workers as two ConnectionManager instances over one
shared bus: the global singleton is the handling worker (empty registry), and a
second manager holds the socket. Reaching the socket therefore proves the
decision travelled over the bus rather than the local registry.
"""
import uuid
from datetime import timedelta
from unittest.mock import AsyncMock

import pytest
from httpx import AsyncClient

from app.core.event_bus import event_bus
from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace
from app.services.agents.liveness import ALIVE_THRESHOLD_SECONDS
from app.services.events.connection_manager import (
    ConnectionManager,
    WebSocketConnection,
    connection_manager,
)
from app.utils import utcnow


@pytest.fixture
def peer_worker():
    """A second worker's ConnectionManager sharing this process's bus.

    Mirrors the production wiring (`ConnectionManager(event_bus)` +
    `listen_for_restart_probes`) so the ack path under test is the real one.
    """
    manager = ConnectionManager(event_bus)
    unsubscribe = manager.listen_for_restart_probes()
    try:
        yield manager
    finally:
        unsubscribe()


def _make_agent(owner: User, name: str) -> Agent:
    """An unpersisted agent — only its id is needed to bind a fake socket."""
    return Agent(
        id=uuid.uuid4(),
        name=name,
        agent_type=AgentType.coding,
        created_by_id=owner.id,
        is_active=True,
    )


def _hold_socket(
    manager: ConnectionManager,
    workspace: Workspace,
    user: User,
    agent: Agent,
) -> WebSocketConnection:
    conn = WebSocketConnection(
        websocket=AsyncMock(),
        workspace_id=workspace.id,
        user_id=user.id,
        agent_id=agent.id,
    )
    manager._connections.append(conn)
    return conn


@pytest.mark.anyio
async def test_restart_reaches_runner_whose_socket_is_on_another_worker(
    client: AsyncClient,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
    peer_worker: ConnectionManager,
    db_session,
):
    """The cross-worker miss: empty local registry, live channel behind the bus."""
    test_agent.last_seen_at = utcnow()
    test_agent.allowed_workspaces = [str(test_workspace.id)]
    await db_session.commit()

    _hold_socket(peer_worker, test_workspace, test_user, test_agent)
    assert connection_manager.get_connection_by_agent_id(test_agent.id) is None

    delivered = []

    async def capture(event):
        delivered.append(event)

    unsub = event_bus.subscribe(
        capture,
        workspace_id=test_workspace.id,
        event_pattern="agent.restart_requested",
    )
    try:
        resp = await client.post(f"/api/agents/{test_agent.id}/restart")
    finally:
        unsub()

    assert resp.status_code == 200
    assert resp.json()["status"] == "restart_requested"
    assert [e.payload["target_agent_id"] for e in delivered] == [str(test_agent.id)]


@pytest.mark.anyio
async def test_restart_with_no_channel_on_any_worker_is_still_409(
    client: AsyncClient,
    test_agent: Agent,
    test_workspace: Workspace,
    peer_worker: ConnectionManager,
    db_session,
):
    """A heartbeating runner with no socket anywhere keeps #128's truthful 409."""
    test_agent.last_seen_at = utcnow()
    test_agent.allowed_workspaces = [str(test_workspace.id)]
    await db_session.commit()

    resp = await client.post(f"/api/agents/{test_agent.id}/restart")

    assert resp.status_code == 409
    assert resp.json()["error_code"] == "no_control_channel"


@pytest.mark.anyio
async def test_restart_with_stale_heartbeat_is_still_503(
    client: AsyncClient,
    test_agent: Agent,
    test_workspace: Workspace,
    peer_worker: ConnectionManager,
    db_session,
):
    """A stale agent is offline regardless of which worker answers."""
    test_agent.last_seen_at = utcnow() - timedelta(seconds=ALIVE_THRESHOLD_SECONDS + 60)
    test_agent.allowed_workspaces = [str(test_workspace.id)]
    await db_session.commit()

    resp = await client.post(f"/api/agents/{test_agent.id}/restart")

    assert resp.status_code == 503


@pytest.mark.anyio
async def test_internal_probe_events_are_never_delivered_to_websocket_clients(
    test_user: User,
    test_workspace: Workspace,
):
    """The probe/ack pair is worker-to-worker plumbing, not part of the WS contract.

    `agent.*` is a pattern runners and admin observers actually subscribe to, so
    without an explicit exclusion these internal frames ride out to every such
    socket — noise on the wire, and a workspace id on the ack that no client
    asked for.
    """
    manager = ConnectionManager(event_bus)
    conn = _hold_socket(manager, test_workspace, test_user, _make_agent(test_user, "sub"))
    await manager.update_subscriptions(conn, ["agent.*"])
    unsubscribe = manager.listen_for_restart_probes()
    try:
        await event_bus.publish(
            event_type="agent.restart_probe",
            payload={"target_agent_id": str(conn.agent_id), "correlation_id": "c1"},
            workspace_id=test_workspace.id,
        )
    finally:
        unsubscribe()
        await manager.disconnect(conn)

    delivered = [call.args[0]["event"] for call in conn.websocket.send_json.call_args_list]
    assert delivered == []


@pytest.mark.anyio
async def test_restart_ignores_an_ack_belonging_to_another_probe(
    client: AsyncClient,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
    peer_worker: ConnectionManager,
    db_session,
):
    """An ack must satisfy only the probe it answers, not whichever is in flight.

    Restarts are concurrent in production (two operators, or a retry). Without
    correlation matching, an ack raised for a DIFFERENT agent's probe resolves
    this one, reporting delivery for a runner with no socket at all.
    """
    test_agent.last_seen_at = utcnow()
    test_agent.allowed_workspaces = [str(test_workspace.id)]
    await db_session.commit()

    # A socket for some other agent, whose probe would ack legitimately.
    noisy_conn = _hold_socket(
        peer_worker, test_workspace, test_user, _make_agent(test_user, "noisy")
    )

    async def ack_every_probe(event):
        await event_bus.publish(
            event_type="agent.restart_ack",
            payload={
                "target_agent_id": str(noisy_conn.agent_id),
                "correlation_id": str(uuid.uuid4()),
                "workspace_id": str(test_workspace.id),
            },
            workspace_id=test_workspace.id,
        )

    unsub = event_bus.subscribe(
        ack_every_probe, workspace_id=None, event_pattern="agent.restart_probe"
    )
    try:
        resp = await client.post(f"/api/agents/{test_agent.id}/restart")
    finally:
        unsub()

    assert resp.status_code == 409
    assert resp.json()["error_code"] == "no_control_channel"


@pytest.mark.anyio
async def test_restart_probe_is_answered_only_for_the_targeted_agent(
    client: AsyncClient,
    test_user: User,
    test_agent: Agent,
    test_workspace: Workspace,
    peer_worker: ConnectionManager,
    db_session,
):
    """A socket for a different agent must not satisfy the probe."""
    test_agent.last_seen_at = utcnow()
    test_agent.allowed_workspaces = [str(test_workspace.id)]
    await db_session.commit()

    _hold_socket(peer_worker, test_workspace, test_user, _make_agent(test_user, "other"))

    resp = await client.post(f"/api/agents/{test_agent.id}/restart")

    assert resp.status_code == 409
    assert resp.json()["error_code"] == "no_control_channel"
