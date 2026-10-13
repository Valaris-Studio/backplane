# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: a grant is only usable after a clean session exit.

The query grants, but the session's exit then fails, or its close task is
cancelled. A clean exit was never established, so the grant must not be
used: the reader fails closed with an opaque denial, never 1013 (that is not
a timeout or overload), and the manager sends no event. The sessions are real
pinned SQLAlchemy AsyncSessions whose instance `close`, which their
__aexit__ runs behind asyncio.shield, raises or ends cancelled. A failing
session constructor or __aenter__ must also fail closed and give the permit
back. Bounded waits, no sleeps, reaped teardown.
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
from tests.services.events.authority_test_support import finished, reap

OPAQUE_DENIALS = {4001, 4002}


@pytest.fixture(autouse=True)
def _isolated_authority_state(monkeypatch):
    monkeypatch.setattr(authority_module, "_authority_read_slots", weakref.WeakKeyDictionary())
    monkeypatch.setattr(authority_module, "_authority_read_owners", weakref.WeakKeyDictionary(),
                        raising=False)


class FailingExitSessions:
    """Real AsyncSessions whose close fails as `outcome` says."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.close_tasks: list[asyncio.Task] = []

    def __call__(self):
        session = AsyncSession()
        outcome = self.outcome

        async def close():
            self.close_tasks.append(asyncio.current_task())
            if outcome == "raises":
                raise RuntimeError("connection reset during rollback")
            raise asyncio.CancelledError

        session.close = close
        return session


def _install(monkeypatch, factory):
    async def granted(session, principal):
        return DeliveryAuthority(role=WorkspaceRole.admin, observer=True)

    monkeypatch.setattr(authority_module.database, "async_session", factory)
    monkeypatch.setattr(authority_module, "current_delivery_authority", granted)


def _principal():
    return DeliveryPrincipal(workspace_id=uuid.uuid4(), user_id=uuid.uuid4())


@pytest.mark.parametrize("outcome", ["raises", "cancelled"])
async def test_grant_is_not_used_when_the_session_exit_fails(monkeypatch, outcome):
    sessions = FailingExitSessions(outcome)
    _install(monkeypatch, sessions)
    read = asyncio.create_task(read_delivery_authority(_principal()))
    try:
        await finished(read, "the reader never answered after a failed session exit")
        result = read.result()
        assert result.close_code is not None, "a grant was used although the session exit failed"
        assert result.close_code in OPAQUE_DENIALS
    finally:
        await reap(read, *sessions.close_tasks)


@pytest.mark.parametrize("outcome", ["raises", "cancelled"])
async def test_manager_sends_nothing_and_denies_opaquely_when_the_exit_fails(monkeypatch, outcome):
    sessions = FailingExitSessions(outcome)
    _install(monkeypatch, sessions)
    bus = EventBus()
    manager = ConnectionManager(bus)  # the real read_delivery_authority
    workspace_id = uuid.uuid4()
    ws = AsyncMock(spec=WebSocket)
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    try:
        await manager.update_subscriptions(conn, ["*"])
        await bus.publish("execution.completed", {"n": 1}, workspace_id)
        await bus.publish("card.updated", {"n": 2}, workspace_id)
        await finished(conn._sender, "the socket was neither served nor closed after a failed exit")

        ws.send_json.assert_not_awaited()
        ws.close.assert_awaited_once()
        assert ws.close.await_args.kwargs["code"] in OPAQUE_DENIALS
        assert manager.active_count == 0 and bus._subscribers == []
    finally:
        await reap(conn._sender, conn._closer, *sessions.close_tasks)


@pytest.mark.parametrize("failure", ["constructor", "enter"])
async def test_session_setup_failure_fails_closed_and_returns_the_permit(monkeypatch, failure):
    class FailingEnter:
        async def __aenter__(self):
            raise RuntimeError("cannot open a session")

        async def __aexit__(self, *exc):
            return False

    def failing_factory():
        if failure == "constructor":
            raise RuntimeError("cannot build a session")
        return FailingEnter()

    _install(monkeypatch, failing_factory)
    first = asyncio.create_task(read_delivery_authority(_principal()))
    after = None
    try:
        await finished(first, "the reader never answered after a session setup failure")
        assert first.result().close_code in OPAQUE_DENIALS

        _install(monkeypatch, AsyncSession)
        after = asyncio.create_task(read_delivery_authority(_principal()))
        await finished(after, "the permit was not returned after a session setup failure")
        assert after.result().close_code is None
        assert not authority_module._read_slots().locked()
    finally:
        await reap(first, after)
