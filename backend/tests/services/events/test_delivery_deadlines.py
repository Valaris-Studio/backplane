# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: authority reads, socket sends and closes are bounded.

Deadlines are set to zero, so they expire at the first await: no sleeps. Each
test bounds its own wait and fails at a named assertion instead of hanging,
and reaps whatever it left running. Timeouts close with retryable 1013.
Unknown errors stay opaque 4001.
"""

import asyncio
import uuid
import weakref
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocket

from app.core.event_bus import EventBus
from app.models.workspace import WorkspaceRole
from app.services.events import authority as authority_module
from app.services.events import connection_manager as manager_module
from app.services.events.authority import (
    CLOSE_CREDENTIAL,
    DeliveryAuthority,
    DeliveryPrincipal,
    read_delivery_authority,
)
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


def _principal():
    return DeliveryPrincipal(workspace_id=uuid.uuid4(), user_id=uuid.uuid4())


def _track_sessions(monkeypatch):
    tracker = SessionTracker()
    monkeypatch.setattr(authority_module.database, "async_session", tracker)
    return tracker


async def _granted(session, principal):
    return DeliveryAuthority(role=WorkspaceRole.member)


async def _stalled(session, principal):
    await asyncio.Event().wait()


async def test_stalled_authority_read_times_out_retryable_and_frees_the_slot(monkeypatch):
    tracker = _track_sessions(monkeypatch)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0, raising=False)
    monkeypatch.setattr(authority_module, "current_delivery_authority", _stalled)

    read = asyncio.create_task(read_delivery_authority(_principal()))
    try:
        await finished(read, "stalled authority read has no deadline")
        assert read.result().close_code == TRY_AGAIN
        # The timed-out session was exited (its async close awaited), not abandoned.
        assert tracker.active == 0 and tracker.exited == tracker.entered == 1

        monkeypatch.setattr(authority_module, "current_delivery_authority", _granted)
        after = await asyncio.wait_for(read_delivery_authority(_principal()), BOUND)
        assert after.close_code is None
        assert tracker.peak == 1
    finally:
        await reap(read)


async def test_slot_wait_timeout_is_retryable_not_a_revoked_credential(monkeypatch):
    tracker = _track_sessions(monkeypatch)
    monkeypatch.setattr(authority_module, "current_delivery_authority", _granted)
    monkeypatch.setattr(authority_module, "AUTHORITY_SLOT_TIMEOUT_SECONDS", 0)
    slots = authority_module._read_slots()
    await slots.acquire()
    try:
        result = await asyncio.wait_for(read_delivery_authority(_principal()), BOUND)
    finally:
        slots.release()
    assert result.close_code == TRY_AGAIN
    assert tracker.entered == 0


async def test_unknown_authority_error_stays_opaque_credential_close(monkeypatch):
    tracker = _track_sessions(monkeypatch)

    async def broken(session, principal):
        raise RuntimeError("relation does not exist")

    monkeypatch.setattr(authority_module, "current_delivery_authority", broken)
    result = await asyncio.wait_for(read_delivery_authority(_principal()), BOUND)
    assert result.close_code == CLOSE_CREDENTIAL
    assert tracker.active == 0 and tracker.exited == tracker.entered == 1


async def test_cancelled_authority_read_releases_the_slot(monkeypatch):
    tracker = _track_sessions(monkeypatch)
    entered = asyncio.Event()

    async def blocking(session, principal):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(authority_module, "current_delivery_authority", blocking)
    pending = asyncio.create_task(read_delivery_authority(_principal()))
    try:
        await asyncio.wait_for(entered.wait(), BOUND)
        pending.cancel()
        await asyncio.wait_for(asyncio.gather(pending, return_exceptions=True), BOUND)
        assert pending.cancelled()
        assert tracker.active == 0 and tracker.cancelled == 1
        assert tracker.exited == tracker.entered == 1

        monkeypatch.setattr(authority_module, "current_delivery_authority", _granted)
        after = await asyncio.wait_for(read_delivery_authority(_principal()), BOUND)
        assert after.close_code is None
        assert tracker.peak == 1
    finally:
        await reap(pending)


async def test_session_exit_holds_the_only_slot_until_it_completes(monkeypatch):
    # A suspended async session exit is still owned by its read, which keeps
    # the sole slot until the exit finishes: no second session can open.
    tracker = _track_sessions(monkeypatch)
    monkeypatch.setattr(authority_module, "current_delivery_authority", _granted)
    gate = tracker.stall_exits()
    first = asyncio.create_task(read_delivery_authority(_principal()))
    second = None
    try:
        await asyncio.wait_for(tracker.exit_started.wait(), BOUND)
        assert not first.done()
        assert authority_module._read_slots().locked()
        assert tracker.active == 1
        second = asyncio.create_task(read_delivery_authority(_principal()))
        gate.set()
        results = await asyncio.wait_for(asyncio.gather(first, second), BOUND)

        assert all(result.close_code is None for result in results)
        assert tracker.peak == 1
        assert tracker.exited == tracker.entered == 2 and tracker.active == 0
    finally:
        gate.set()
        await reap(first, second)


def _socket(*, stall_send=False, stall_close=False):
    ws = AsyncMock(spec=WebSocket)
    never = asyncio.Event()

    async def stalled(*args, **kwargs):
        await never.wait()

    ws.send_json = AsyncMock(side_effect=stalled if stall_send else None)
    ws.close = AsyncMock(side_effect=stalled if stall_close else None)
    return ws


async def _member(principal):
    return DeliveryAuthority(role=WorkspaceRole.member)


async def _assert_cleaned_up(manager, bus, conn):
    assert conn._sender.done()
    assert manager.active_count == 0 and bus._subscribers == []
    await asyncio.wait_for(conn._outbox.join(), BOUND)


async def test_stalled_send_closes_retryable_and_cleans_up(monkeypatch):
    monkeypatch.setattr(manager_module, "SEND_TIMEOUT_SECONDS", 0, raising=False)
    bus = EventBus()
    manager = ConnectionManager(bus, authority=_member)
    workspace_id = uuid.uuid4()
    ws = _socket(stall_send=True)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await finished(conn._sender, "stalled send has no deadline")

        ws.close.assert_awaited_once()
        assert ws.close.await_args.kwargs["code"] == TRY_AGAIN
        await _assert_cleaned_up(manager, bus, conn)
    finally:
        await reap(conn._sender, conn._closer)


async def test_stalled_close_still_disconnects_and_stops_the_sender(monkeypatch):
    monkeypatch.setattr(manager_module, "CLOSE_TIMEOUT_SECONDS", 0, raising=False)

    async def revoked(principal):
        return DeliveryAuthority(close_code=CLOSE_CREDENTIAL)

    bus = EventBus()
    manager = ConnectionManager(bus, authority=revoked)
    workspace_id = uuid.uuid4()
    ws = _socket(stall_close=True)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await finished(conn._sender, "stalled close has no deadline")

        assert ws.close.await_args.kwargs["code"] == CLOSE_CREDENTIAL
        ws.send_json.assert_not_awaited()
        await _assert_cleaned_up(manager, bus, conn)
    finally:
        await reap(conn._sender, conn._closer)


async def test_backlog_close_is_bounded_when_the_socket_stalls(monkeypatch):
    monkeypatch.setattr(manager_module, "OUTBOX_LIMIT", 1)
    monkeypatch.setattr(manager_module, "CLOSE_TIMEOUT_SECONDS", 0, raising=False)
    entered = asyncio.Event()

    async def held(principal):
        entered.set()
        await asyncio.Event().wait()

    bus = EventBus()
    manager = ConnectionManager(bus, authority=held)
    workspace_id = uuid.uuid4()
    ws = _socket(stall_close=True)
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 0}, workspace_id)
        await asyncio.wait_for(entered.wait(), BOUND)
        for n in range(1, 5):
            await bus.publish("card.updated", {"n": n}, workspace_id)
        assert conn._closer is not None
        await finished(conn._closer, "backlog close has no deadline")

        assert ws.close.await_args.kwargs["code"] == TRY_AGAIN
        await _assert_cleaned_up(manager, bus, conn)
    finally:
        await reap(conn._sender, conn._closer)
