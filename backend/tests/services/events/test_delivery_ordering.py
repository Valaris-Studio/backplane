# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: per-socket delivery order, uniqueness, per-event
authority and cleanup of the decoupled sender."""

import asyncio
import uuid
from unittest.mock import AsyncMock

from fastapi import WebSocket

from app.core.event_bus import EventBus
from app.models.workspace import WorkspaceRole
from app.services.events import connection_manager as manager_module
from app.services.events.authority import CLOSE_CREDENTIAL, DeliveryAuthority
from app.services.events.connection_manager import ConnectionManager

OBSERVER = DeliveryAuthority(role=WorkspaceRole.admin, observer=True)
MEMBER = DeliveryAuthority(role=WorkspaceRole.member, observer=False)


def _socket():
    ws = AsyncMock(spec=WebSocket)
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


def _sent(ws):
    return [call.args[0] for call in ws.send_json.await_args_list]


async def _granting(principal):
    return OBSERVER


async def test_overlapping_patterns_deliver_each_event_once_in_publish_order():
    bus = EventBus()
    manager = ConnectionManager(bus, authority=_granting)
    workspace_id = uuid.uuid4()
    ws = _socket()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    await manager.update_subscriptions(conn, ["card.*", "*", "card.updated", "c?rd.*"])

    for n in range(5):
        await bus.publish("card.updated", {"n": n}, workspace_id)
    await asyncio.wait_for(conn._outbox.join(), 2)

    assert [frame["payload"]["n"] for frame in _sent(ws)] == [0, 1, 2, 3, 4]
    assert len(bus._subscribers) == 1
    await manager.disconnect(conn)


async def test_demotion_between_two_queued_events_filters_the_second():
    # Both events are queued before the sender runs. Authority is read for
    # each one, so a demotion committed between them withholds the second
    # observer event. A once-per-batch snapshot would have sent both.
    bus = EventBus()
    answers = iter([OBSERVER, MEMBER, MEMBER])
    reads = []
    gate = asyncio.Event()

    async def demoting(principal):
        await gate.wait()
        reads.append(principal)
        return next(answers)

    manager = ConnectionManager(bus, authority=demoting)
    workspace_id = uuid.uuid4()
    ws = _socket()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    await manager.update_subscriptions(conn, ["*"])

    await bus.publish("execution.completed", {"n": 1}, workspace_id)
    await bus.publish("execution.completed", {"n": 2}, workspace_id)
    await bus.publish("card.updated", {"n": 3}, workspace_id)
    gate.set()
    await asyncio.wait_for(conn._outbox.join(), 2)

    assert [(f["event"], f["payload"]["n"]) for f in _sent(ws)] == [
        ("execution.completed", 1),
        ("card.updated", 3),
    ]
    assert len(reads) == 3
    await manager.disconnect(conn)


async def test_revocation_while_events_are_queued_closes_before_any_later_send():
    bus = EventBus()
    answers = iter([MEMBER, DeliveryAuthority(close_code=CLOSE_CREDENTIAL)])

    async def revoking(principal):
        return next(answers)

    manager = ConnectionManager(bus, authority=revoking)
    workspace_id = uuid.uuid4()
    ws = _socket()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    await manager.update_subscriptions(conn, ["card.*"])

    for n in range(3):
        await bus.publish("card.updated", {"n": n}, workspace_id)
    await asyncio.wait_for(conn._outbox.join(), 2)

    assert [f["payload"]["n"] for f in _sent(ws)] == [0]
    ws.close.assert_awaited_once()
    assert ws.close.await_args.kwargs["code"] == CLOSE_CREDENTIAL
    assert manager.active_count == 0 and conn._sender.done()
    assert bus._subscribers == []


async def test_disconnect_cancels_and_awaits_a_sender_blocked_on_authority():
    bus = EventBus()
    blocked = asyncio.Event()

    async def never(principal):
        blocked.set()
        await asyncio.Event().wait()

    manager = ConnectionManager(bus, authority=never)
    workspace_id = uuid.uuid4()
    ws = _socket()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    await manager.update_subscriptions(conn, ["card.*"])
    await bus.publish("card.updated", {"n": 0}, workspace_id)
    await bus.publish("card.updated", {"n": 1}, workspace_id)
    await asyncio.wait_for(blocked.wait(), 2)

    await asyncio.wait_for(manager.disconnect(conn), 2)

    assert conn._sender.done()
    assert bus._subscribers == [] and manager.active_count == 0
    # Nothing waiting on the queue is left hanging after the disconnect.
    await asyncio.wait_for(conn._outbox.join(), 1)
    ws.send_json.assert_not_awaited()


async def test_overflow_closes_once_with_1013_and_cleans_up(monkeypatch):
    monkeypatch.setattr(manager_module, "OUTBOX_LIMIT", 3)
    bus = EventBus()
    blocked = asyncio.Event()

    async def never(principal):
        blocked.set()
        await asyncio.Event().wait()

    manager = ConnectionManager(bus, authority=never)
    workspace_id = uuid.uuid4()
    ws = _socket()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    await manager.update_subscriptions(conn, ["card.*"])

    # One event is held by the sender, three fill the outbox, the rest overflow.
    await bus.publish("card.updated", {"n": 0}, workspace_id)
    await asyncio.wait_for(blocked.wait(), 2)
    for n in range(1, 20):
        await bus.publish("card.updated", {"n": n}, workspace_id)
    closer = conn._closer
    assert closer is not None
    await asyncio.wait_for(closer, 2)

    ws.close.assert_awaited_once()
    assert ws.close.await_args.kwargs["code"] == 1013
    assert conn._sender.done() and manager.active_count == 0
    assert bus._subscribers == []
    ws.send_json.assert_not_awaited()
