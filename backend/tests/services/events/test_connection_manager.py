# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocket

from app.core.event_bus import EventBus
from app.services.events.connection_manager import ConnectionManager


def make_mock_ws():
    ws = AsyncMock(spec=WebSocket)
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


@pytest.fixture
def bus():
    return EventBus()


@pytest.fixture
def manager(bus):
    return ConnectionManager(bus)


async def test_connect_registers_connection(manager):
    ws = make_mock_ws()
    workspace_id = uuid.uuid4()
    user_id = uuid.uuid4()

    conn = await manager.connect(ws, workspace_id, user_id)

    assert manager.active_count == 1
    assert conn.workspace_id == workspace_id
    assert conn.user_id == user_id
    assert conn.agent_id is None


async def test_disconnect_removes_connection(manager):
    ws = make_mock_ws()
    conn = await manager.connect(ws, uuid.uuid4(), uuid.uuid4())
    assert manager.active_count == 1

    await manager.disconnect(conn)

    assert manager.active_count == 0


async def test_disconnect_unsubscribes_from_event_bus(manager, bus):
    ws = make_mock_ws()
    workspace_id = uuid.uuid4()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())

    await manager.update_subscriptions(conn, ["card.*"])
    initial_subscriber_count = len(bus._subscribers)
    assert initial_subscriber_count > 0

    await manager.disconnect(conn)

    assert len(bus._subscribers) == 0


async def test_update_subscriptions_registers_on_event_bus(manager, bus):
    ws = make_mock_ws()
    workspace_id = uuid.uuid4()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())

    await manager.update_subscriptions(conn, ["card.*"])

    assert len(bus._subscribers) == 1
    assert conn.patterns == ["card.*"]


async def test_update_subscriptions_replaces_old(manager, bus):
    ws = make_mock_ws()
    workspace_id = uuid.uuid4()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())

    await manager.update_subscriptions(conn, ["card.*"])
    assert len(bus._subscribers) == 1

    await manager.update_subscriptions(conn, ["approval.*", "execution.*"])
    assert len(bus._subscribers) == 2
    assert conn.patterns == ["approval.*", "execution.*"]


async def test_deliver_sends_json(manager, bus):
    ws = make_mock_ws()
    workspace_id = uuid.uuid4()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())

    await manager.update_subscriptions(conn, ["card.*"])

    await bus.publish("card.created", {"title": "Test Card"}, workspace_id)

    ws.send_json.assert_awaited_once()
    sent_data = ws.send_json.call_args[0][0]
    assert sent_data["event"] == "card.created"
    assert sent_data["payload"] == {"title": "Test Card"}
    assert "timestamp" in sent_data
    assert "event_id" in sent_data


async def test_deliver_error_triggers_disconnect(manager, bus):
    ws = make_mock_ws()
    ws.send_json = AsyncMock(side_effect=RuntimeError("connection closed"))
    workspace_id = uuid.uuid4()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())

    await manager.update_subscriptions(conn, ["card.*"])

    await bus.publish("card.created", {"title": "Test"}, workspace_id)

    assert manager.active_count == 0


async def test_shutdown_closes_all(manager):
    ws1 = make_mock_ws()
    ws2 = make_mock_ws()

    await manager.connect(ws1, uuid.uuid4(), uuid.uuid4())
    await manager.connect(ws2, uuid.uuid4(), uuid.uuid4())
    assert manager.active_count == 2

    await manager.shutdown()

    assert manager.active_count == 0
    ws1.close.assert_awaited_once()
    ws2.close.assert_awaited_once()


async def test_connect_with_agent_id(manager):
    ws = make_mock_ws()
    workspace_id = uuid.uuid4()
    user_id = uuid.uuid4()
    agent_id = uuid.uuid4()

    conn = await manager.connect(ws, workspace_id, user_id, agent_id=agent_id)

    assert conn.agent_id == agent_id
    assert manager.active_count == 1


async def test_api_key_first_used_delivered_only_to_owning_user(manager, bus):
    """api_key.first_used is per-user, like notification.created.

    The event is published to every workspace the key's user belongs to, so
    without the filter a co-member's socket would learn that someone else
    connected their coding agent.
    """
    workspace_id = uuid.uuid4()
    owner_id = uuid.uuid4()
    bystander_id = uuid.uuid4()

    owner_ws = make_mock_ws()
    bystander_ws = make_mock_ws()
    owner_conn = await manager.connect(owner_ws, workspace_id, owner_id)
    bystander_conn = await manager.connect(bystander_ws, workspace_id, bystander_id)
    await manager.update_subscriptions(owner_conn, ["api_key.*"])
    await manager.update_subscriptions(bystander_conn, ["api_key.*"])

    await bus.publish(
        "api_key.first_used",
        {"api_key_id": str(uuid.uuid4()), "user_id": str(owner_id), "key_name": "CLI"},
        workspace_id,
    )

    owner_ws.send_json.assert_awaited_once()
    assert owner_ws.send_json.call_args[0][0]["event"] == "api_key.first_used"
    bystander_ws.send_json.assert_not_awaited()


async def test_api_key_first_used_without_user_id_is_not_delivered(manager, bus):
    """A payload missing user_id must not broadcast to the whole workspace."""
    workspace_id = uuid.uuid4()
    ws = make_mock_ws()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    await manager.update_subscriptions(conn, ["api_key.*"])

    await bus.publish("api_key.first_used", {"api_key_id": str(uuid.uuid4())}, workspace_id)

    ws.send_json.assert_not_awaited()


def test_singleton_lives_in_services_not_routers():
    from app.services.events.connection_manager import connection_manager as svc_cm
    from app.routers import events as router_events
    assert router_events.connection_manager is svc_cm, (
        "router's connection_manager must be the same instance re-exported from services"
    )
