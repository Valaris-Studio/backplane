# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: real authority-read outcomes, through the manager.

Neither the close nor the 1013 is injected. The underlying read stalls, and
the reader's own deadline (zero, so it expires at the first await) must
produce the retryable close that the manager then performs and cleans up.
Sends and closes must never happen while an authority session is open. No
sleeps: every wait is bounded, failures name the missing behavior, and
leftover tasks are reaped.
"""

import asyncio
import uuid
import weakref
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocket

from app.core.event_bus import EventBus
from app.models.workspace import WorkspaceRole
from app.routers.events import _apply_subscribe_frame
from app.services.events import authority as authority_module
from app.services.events import connection_manager as manager_module
from app.services.events.authority import CLOSE_CREDENTIAL, DeliveryAuthority
from app.services.events.connection_manager import ConnectionManager
from tests.services.events.authority_test_support import (
    BOUND,
    SessionTracker,
    finished,
    reap,
)

TRY_AGAIN = 1013


@pytest.fixture(autouse=True)
def _isolated_authority_slots(monkeypatch):
    # A RED run may leave a read holding the per-loop slot until it is reaped;
    # a fresh slot map per test means a slot left held is not shared with the
    # next test (task cleanup itself is checked by reap()).
    monkeypatch.setattr(authority_module, "_authority_read_slots", weakref.WeakKeyDictionary())
OPAQUE_REVOCATION_REASONS = {"Authentication failed", "Workspace not found"}


def _real_reader(monkeypatch, outcome):
    """Route the production reader through a tracked session whose query
    behaves as `outcome`; the reader itself is not replaced."""
    tracker = SessionTracker()

    async def query(session, principal):
        return await outcome()

    monkeypatch.setattr(authority_module.database, "async_session", tracker)
    monkeypatch.setattr(authority_module, "current_delivery_authority", query)
    return tracker


async def _stall():
    await asyncio.Event().wait()


def _socket(tracker, *, stall_close=False):
    """Records whether an authority session was open at each send/close."""
    ws = AsyncMock(spec=WebSocket)
    ws.sessions_open_at_io = []
    never = asyncio.Event()

    async def send(*args, **kwargs):
        ws.sessions_open_at_io.append(tracker.active)

    async def close(*args, **kwargs):
        ws.sessions_open_at_io.append(tracker.active)
        if stall_close:
            await never.wait()

    ws.send_json = AsyncMock(side_effect=send)
    ws.close = AsyncMock(side_effect=close)
    return ws


def _assert_one_opaque_retryable_close(ws):
    ws.close.assert_awaited_once()
    close = ws.close.await_args.kwargs
    assert close["code"] == TRY_AGAIN
    assert close["reason"] == authority_module.CLOSE_REASONS[TRY_AGAIN]
    assert close["reason"] not in OPAQUE_REVOCATION_REASONS


async def _assert_cleaned_up(manager, bus, conn, tracker):
    assert conn._sender.done()
    assert manager.active_count == 0 and bus._subscribers == []
    await asyncio.wait_for(conn._outbox.join(), BOUND)
    assert tracker.active == 0 and tracker.exited == tracker.entered
    assert tracker.peak <= 1


async def test_authority_read_timeout_during_delivery_closes_retryable_and_cleans_up(monkeypatch):
    tracker = _real_reader(monkeypatch, _stall)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0, raising=False)
    bus = EventBus()
    manager = ConnectionManager(bus)  # the real read_delivery_authority
    workspace_id = uuid.uuid4()
    ws = _socket(tracker)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await bus.publish("card.updated", {"n": 2}, workspace_id)
        await finished(conn._sender, "authority read timeout did not close the socket")

        _assert_one_opaque_retryable_close(ws)
        ws.send_json.assert_not_awaited()
        assert ws.sessions_open_at_io == [0]
        await _assert_cleaned_up(manager, bus, conn, tracker)
    finally:
        await reap(conn._sender, conn._closer)


async def test_authority_read_timeout_during_subscribe_admission_closes_retryable(monkeypatch):
    tracker = _real_reader(monkeypatch, _stall)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0, raising=False)
    bus = EventBus()
    manager = ConnectionManager(bus)  # the real read_delivery_authority
    workspace_id = uuid.uuid4()
    ws = _socket(tracker)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    admission = asyncio.create_task(
        _apply_subscribe_frame(ws, conn, ["card.*", "*"], manager=manager)
    )
    try:
        await finished(admission, "authority read timeout did not end subscribe admission")
        admission.result()

        _assert_one_opaque_retryable_close(ws)
        # Neither admitted nor told about denials: no frame at all.
        ws.send_json.assert_not_awaited()
        assert conn.patterns == []
        assert ws.sessions_open_at_io == [0]
        await finished(conn._sender, "sender survived the admission close")
        await _assert_cleaned_up(manager, bus, conn, tracker)
    finally:
        await reap(admission, conn._sender, conn._closer)


async def test_admitted_delivery_sends_with_no_authority_session_open(monkeypatch):
    async def member():
        return DeliveryAuthority(role=WorkspaceRole.member)

    tracker = _real_reader(monkeypatch, member)
    bus = EventBus()
    manager = ConnectionManager(bus)
    workspace_id = uuid.uuid4()
    ws = _socket(tracker)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await bus.publish("card.updated", {"n": 2}, workspace_id)
        await asyncio.wait_for(conn._outbox.join(), BOUND)

        assert ws.send_json.await_count == 2
        assert ws.sessions_open_at_io == [0, 0]
        assert tracker.exited == tracker.entered == 2 and tracker.peak == 1
    finally:
        await manager.disconnect(conn)
        await reap(conn._sender)


async def test_send_waits_until_the_authority_session_has_exited(monkeypatch):
    async def member():
        return DeliveryAuthority(role=WorkspaceRole.member)

    tracker = _real_reader(monkeypatch, member)
    gate = tracker.stall_exits()
    bus = EventBus()
    manager = ConnectionManager(bus)
    workspace_id = uuid.uuid4()
    ws = _socket(tracker)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await asyncio.wait_for(tracker.exit_started.wait(), BOUND)
        # The session exit is suspended: the send must not overtake it.
        ws.send_json.assert_not_awaited()
        assert tracker.active == 1

        gate.set()
        await asyncio.wait_for(conn._outbox.join(), BOUND)
        assert ws.send_json.await_count == 1
        assert ws.sessions_open_at_io == [0]
        assert tracker.peak == 1 and tracker.exited == tracker.entered == 1
    finally:
        gate.set()
        await manager.disconnect(conn)
        await reap(conn._sender)


async def test_revocation_closes_with_no_authority_session_open(monkeypatch):
    async def revoked():
        return DeliveryAuthority(close_code=CLOSE_CREDENTIAL)

    tracker = _real_reader(monkeypatch, revoked)
    bus = EventBus()
    manager = ConnectionManager(bus)
    workspace_id = uuid.uuid4()
    ws = _socket(tracker)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await finished(conn._sender, "revocation did not close the socket")

        assert ws.close.await_args.kwargs["code"] == CLOSE_CREDENTIAL
        assert ws.sessions_open_at_io == [0]
        await _assert_cleaned_up(manager, bus, conn, tracker)
    finally:
        await reap(conn._sender, conn._closer)


async def test_shutdown_is_bounded_when_a_socket_close_stalls(monkeypatch):
    monkeypatch.setattr(manager_module, "CLOSE_TIMEOUT_SECONDS", 0, raising=False)

    async def member():
        return DeliveryAuthority(role=WorkspaceRole.member)

    tracker = _real_reader(monkeypatch, member)
    bus = EventBus()
    manager = ConnectionManager(bus)
    workspace_id = uuid.uuid4()
    stalled_ws = _socket(tracker, stall_close=True)
    healthy_ws = _socket(tracker)
    stalled = await manager.connect(stalled_ws, workspace_id, uuid.uuid4())
    healthy = await manager.connect(healthy_ws, workspace_id, uuid.uuid4())
    shutdown = asyncio.create_task(manager.shutdown())
    try:
        await finished(shutdown, "shutdown waits forever on a stalled socket close")

        healthy_ws.close.assert_awaited_once()
        assert manager.active_count == 0
        for conn in (stalled, healthy):
            assert conn._sender.done()
            await asyncio.wait_for(conn._outbox.join(), BOUND)
    finally:
        await reap(shutdown, stalled._sender, healthy._sender)
