# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: the authority slot stays owned until a SHIELDED
session close finishes.

The sessions are real pinned SQLAlchemy AsyncSessions, whose __aexit__ runs
`close()` as a separate task behind asyncio.shield. Only the first session's
close is held on a gate (the instance's `close`, which that __aexit__ calls).
A reader that stops waiting, by deadline or by cancellation, while that
shielded close is still running must not hand the sole slot to another
session, and nothing may enter or send before the close finishes. Once it
finishes, everything is reclaimed. No sleeps; every wait is bounded.
"""

import asyncio
import uuid
import weakref
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocket
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import EventBus
from app.models.workspace import WorkspaceRole
from app.services.events import authority as authority_module
from app.services.events.authority import DeliveryAuthority, DeliveryPrincipal, read_delivery_authority
from app.services.events.connection_manager import ConnectionManager
from tests.services.events.authority_test_support import BOUND, finished, reap

TRY_AGAIN = 1013


@pytest.fixture(autouse=True)
def _isolated_authority_slots(monkeypatch):
    monkeypatch.setattr(authority_module, "_authority_read_slots", weakref.WeakKeyDictionary())


class ShieldedCloseSessions:
    """Factory of real AsyncSessions. The first one's close is held on a gate;
    the log records the order sessions are entered and closes finish."""

    def __init__(self):
        self.log: list[str] = []
        self.first_close_started = asyncio.Event()
        self.query_stalled = asyncio.Event()
        self.query_cancelled = asyncio.Event()
        self.first_close_gate = asyncio.Event()
        self.close_tasks: list[asyncio.Task] = []
        self._count = 0

    def __call__(self):
        self._count += 1
        number = self._count
        session = AsyncSession()
        library_close = session.close

        async def close():
            self.close_tasks.append(asyncio.current_task())
            if number == 1:
                self.first_close_started.set()
                await self.first_close_gate.wait()
            await library_close()
            self.log.append(f"close{number}-finished")

        session.close = close
        self.log.append(f"session{number}-entered")
        return session


def _install(monkeypatch, *, stall_first_query=False):
    sessions = ShieldedCloseSessions()
    queries = {"count": 0}

    async def granted(session, principal):
        queries["count"] += 1
        if stall_first_query and queries["count"] == 1:
            sessions.log.append("query1-stalled")
            sessions.query_stalled.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                sessions.log.append("query1-cancelled")
                sessions.query_cancelled.set()
                raise
        return DeliveryAuthority(role=WorkspaceRole.member)

    monkeypatch.setattr(authority_module.database, "async_session", sessions)
    monkeypatch.setattr(authority_module, "current_delivery_authority", granted)
    return sessions


def _principal():
    return DeliveryPrincipal(workspace_id=uuid.uuid4(), user_id=uuid.uuid4())


async def test_read_deadline_during_shielded_close_keeps_the_slot_until_it_finishes(monkeypatch):
    sessions = _install(monkeypatch)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0)
    first = asyncio.create_task(read_delivery_authority(_principal()))
    second = None
    try:
        await asyncio.wait_for(sessions.first_close_started.wait(), BOUND)
        # The caller may stop waiting (retryable), but must not give up the slot.
        await finished(first, "the reader never stopped waiting on its deadline")
        assert first.result().close_code == TRY_AGAIN
        assert authority_module._read_slots().locked(), "slot released while the shielded close still runs"

        monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 3)
        second = asyncio.create_task(read_delivery_authority(_principal()))
        sessions.first_close_gate.set()
        await finished(second, "the slot was never reclaimed after the close finished")

        assert second.result().close_code is None
        assert sessions.log.index("close1-finished") < sessions.log.index("session2-entered")
        assert all(task.done() for task in sessions.close_tasks)
        assert not authority_module._read_slots().locked()
    finally:
        sessions.first_close_gate.set()
        await reap(first, second, *sessions.close_tasks)


async def test_cancelled_reader_does_not_abandon_a_shielded_close(monkeypatch):
    sessions = _install(monkeypatch)
    first = asyncio.create_task(read_delivery_authority(_principal()))
    second = None
    try:
        await asyncio.wait_for(sessions.first_close_started.wait(), BOUND)
        first.cancel()
        await asyncio.wait({first}, timeout=BOUND)
        assert first.done()
        assert authority_module._read_slots().locked(), "slot released while the shielded close still runs"

        second = asyncio.create_task(read_delivery_authority(_principal()))
        sessions.first_close_gate.set()
        await finished(second, "the slot was never reclaimed after the close finished")

        assert second.result().close_code is None
        assert sessions.log.index("close1-finished") < sessions.log.index("session2-entered")
        assert all(task.done() for task in sessions.close_tasks)
    finally:
        sessions.first_close_gate.set()
        await reap(first, second, *sessions.close_tasks)


def _socket(log, label):
    ws = AsyncMock(spec=WebSocket)

    async def send(*args, **kwargs):
        log.append(f"{label}-sent")

    async def close(*args, **kwargs):
        log.append(f"{label}-closed")

    ws.send_json = AsyncMock(side_effect=send)
    ws.close = AsyncMock(side_effect=close)
    return ws


async def test_no_other_socket_reads_or_sends_before_a_timed_out_shielded_close_finishes(monkeypatch):
    sessions = _install(monkeypatch)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0)
    bus = EventBus()
    manager = ConnectionManager(bus)  # the real read_delivery_authority
    workspace_id = uuid.uuid4()
    first_ws = _socket(sessions.log, "first")
    second_ws = _socket(sessions.log, "second")
    first = await manager.connect(first_ws, workspace_id, uuid.uuid4())
    second = await manager.connect(second_ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(first, ["first.*"])
        await bus.publish("first.updated", {"n": 1}, workspace_id)
        await asyncio.wait_for(sessions.first_close_started.wait(), BOUND)
        # The timed-out socket is closed as retryable overload.
        await finished(first._sender, "the timed-out socket was never closed")
        assert first_ws.close.await_args.kwargs["code"] == TRY_AGAIN

        monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 3)
        await manager.update_subscriptions(second, ["second.*"])
        await bus.publish("second.updated", {"n": 2}, workspace_id)
        sessions.first_close_gate.set()
        await asyncio.wait_for(second._outbox.join(), BOUND)

        log = sessions.log
        assert log.index("close1-finished") < log.index("session2-entered")
        assert log.index("close1-finished") < log.index("second-sent")
        assert all(task.done() for task in sessions.close_tasks)
    finally:
        sessions.first_close_gate.set()
        await manager.disconnect(second)
        await reap(first._sender, second._sender, first._closer, *sessions.close_tasks)


async def test_read_deadline_during_query_returns_while_the_close_hangs_and_keeps_the_slot(monkeypatch):
    # The usual case: the deadline fires during the query. The session's
    # shielded close then runs after that single cancellation and can hang
    # (e.g. rollback against an unreachable database).
    sessions = _install(monkeypatch, stall_first_query=True)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0)
    first = asyncio.create_task(read_delivery_authority(_principal()))
    second = None
    try:
        await finished(first, "the reader waited on a hung close past its deadline")
        assert first.result().close_code == TRY_AGAIN
        await asyncio.wait_for(sessions.first_close_started.wait(), BOUND)
        assert "query1-cancelled" in sessions.log
        assert authority_module._read_slots().locked(), "slot released while the shielded close still runs"

        monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 3)
        second = asyncio.create_task(read_delivery_authority(_principal()))
        sessions.first_close_gate.set()
        await finished(second, "the slot was never reclaimed after the close finished")

        assert second.result().close_code is None
        assert sessions.log.index("close1-finished") < sessions.log.index("session2-entered")
        assert all(task.done() for task in sessions.close_tasks)
    finally:
        sessions.first_close_gate.set()
        await reap(first, second, *sessions.close_tasks)


async def test_socket_is_closed_retryably_while_a_timed_out_reads_close_still_hangs(monkeypatch):
    sessions = _install(monkeypatch, stall_first_query=True)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0)
    bus = EventBus()
    manager = ConnectionManager(bus)  # the real read_delivery_authority
    workspace_id = uuid.uuid4()
    ws = _socket(sessions.log, "stuck")
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["card.*"])
        await bus.publish("card.updated", {"n": 1}, workspace_id)
        await finished(conn._sender, "the socket stayed open behind a hung session close")

        ws.close.assert_awaited_once()
        assert ws.close.await_args.kwargs["code"] == TRY_AGAIN
        ws.send_json.assert_not_awaited()
        assert manager.active_count == 0 and bus._subscribers == []
        assert authority_module._read_slots().locked(), "slot released while the shielded close still runs"

        # A bounded read must await its own session exit, so the positive
        # control runs with the normal deadline rather than zero.
        monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 3)
        sessions.first_close_gate.set()
        after = await asyncio.wait_for(read_delivery_authority(_principal()), BOUND)
        assert after.close_code is None
        assert all(task.done() for task in sessions.close_tasks)
    finally:
        sessions.first_close_gate.set()
        await reap(conn._sender, conn._closer, *sessions.close_tasks)


async def test_cancelled_caller_cannot_leave_an_unbounded_query_holding_the_slot(monkeypatch):
    # The caller (a disconnecting socket's sender) is cancelled while the
    # query stalls. Whoever then owns the read must still bound the query by
    # the read deadline, so the slot is reclaimed and nothing holds it forever.
    # The deadline is short but nonzero, so the stalled query is observed first;
    # the test then waits (bounded) on events, never on a polling sleep.
    sessions = _install(monkeypatch, stall_first_query=True)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0.2)
    sessions.first_close_gate.set()
    caller = asyncio.create_task(read_delivery_authority(_principal()))
    after = None
    try:
        await asyncio.wait_for(sessions.query_stalled.wait(), BOUND)
        caller.cancel()
        await asyncio.wait({caller}, timeout=BOUND)
        assert caller.done()

        await asyncio.wait_for(sessions.query_cancelled.wait(), BOUND)
        monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 3)
        after = asyncio.create_task(read_delivery_authority(_principal()))
        await finished(after, "the slot was never reclaimed after the caller was cancelled")
        assert after.result().close_code is None
        assert all(task.done() for task in sessions.close_tasks)
    finally:
        await reap(caller, after, *sessions.close_tasks)
