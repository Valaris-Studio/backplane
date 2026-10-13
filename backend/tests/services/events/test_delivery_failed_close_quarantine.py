# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: after a failed or cancelled session close, the sole
authority permit stays quarantined.

Pinned SQLAlchemy cannot prove the failed connection was reclaimed (after a
cancelled close it may stay held until GC). So no further authority session
may be admitted: later reads shed retryable 1013 at the slot wait, and the
quarantine is logged once as needing process recovery. Clean exits and
ordinary timeouts keep releasing normally. Nothing here depends on GC timing.
Bounded waits, no sleeps, reaped teardown.
"""

import asyncio
import logging
import uuid
import weakref

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.workspace import WorkspaceRole
from app.services.events import authority as authority_module
from app.services.events.authority import DeliveryAuthority, DeliveryPrincipal, read_delivery_authority
from tests.services.events.authority_test_support import finished, reap

TRY_AGAIN = 1013
OPAQUE_DENIALS = {4001, 4002}


@pytest.fixture(autouse=True)
def _isolated_authority_state(monkeypatch):
    monkeypatch.setattr(authority_module, "_authority_read_slots", weakref.WeakKeyDictionary())
    monkeypatch.setattr(authority_module, "_authority_read_owners", weakref.WeakKeyDictionary(),
                        raising=False)


class Sessions:
    """Real AsyncSessions. The first one's close fails as `first_close` says
    ("raises", "cancelled" or None for a clean close); later ones are clean.
    Records which sessions were entered."""

    def __init__(self, first_close=None):
        self.first_close = first_close
        self.entered: list[int] = []
        self.close_tasks: list[asyncio.Task] = []

    def __call__(self):
        number = len(self.entered) + 1
        self.entered.append(number)
        session = AsyncSession()
        library_close = session.close
        failure = self.first_close if number == 1 else None

        async def close():
            self.close_tasks.append(asyncio.current_task())
            if failure == "raises":
                raise RuntimeError("connection reset during rollback")
            if failure == "cancelled":
                raise asyncio.CancelledError
            await library_close()

        session.close = close
        return session


def _install(monkeypatch, sessions, query=None):
    async def granted(session, principal):
        return DeliveryAuthority(role=WorkspaceRole.member)

    monkeypatch.setattr(authority_module.database, "async_session", sessions)
    monkeypatch.setattr(authority_module, "current_delivery_authority", query or granted)


def _principal():
    return DeliveryPrincipal(workspace_id=uuid.uuid4(), user_id=uuid.uuid4())


def _authority_errors(caplog):
    return [r for r in caplog.records
            if r.name == authority_module.__name__ and r.levelno >= logging.ERROR]


@pytest.mark.parametrize("failure", ["raises", "cancelled"])
async def test_failed_close_quarantines_the_permit_so_no_session_is_admitted(monkeypatch, caplog, failure):
    caplog.set_level(logging.WARNING, logger=authority_module.__name__)
    sessions = Sessions(first_close=failure)
    _install(monkeypatch, sessions)
    first = asyncio.create_task(read_delivery_authority(_principal()))
    later = []
    try:
        await finished(first, "the reader never answered after a failed session close")
        assert first.result().close_code in OPAQUE_DENIALS

        # The slot wait sheds immediately instead of admitting a session.
        monkeypatch.setattr(authority_module, "AUTHORITY_SLOT_TIMEOUT_SECONDS", 0)
        for _ in range(2):
            read = asyncio.create_task(read_delivery_authority(_principal()))
            later.append(read)
            await finished(read, "a later read never answered while the permit was quarantined")
            assert read.result().close_code == TRY_AGAIN
        assert sessions.entered == [1], "another authority session was admitted after a failed close"
        assert authority_module._read_slots().locked()
        assert len(_authority_errors(caplog)) == 1, "the quarantine must be logged exactly once"
    finally:
        await reap(first, *later, *sessions.close_tasks)


async def test_clean_closes_keep_releasing_the_permit(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=authority_module.__name__)
    sessions = Sessions()
    _install(monkeypatch, sessions)
    reads = []
    try:
        for _ in range(3):
            read = asyncio.create_task(read_delivery_authority(_principal()))
            reads.append(read)
            await finished(read, "a clean read never answered")
            assert read.result().close_code is None
        assert sessions.entered == [1, 2, 3]
        assert not authority_module._read_slots().locked()
        assert _authority_errors(caplog) == []
    finally:
        await reap(*reads, *sessions.close_tasks)


async def test_ordinary_query_timeout_with_a_clean_close_does_not_quarantine(monkeypatch, caplog):
    caplog.set_level(logging.WARNING, logger=authority_module.__name__)
    stall = {"first": True}

    async def query(session, principal):
        if stall["first"]:
            stall["first"] = False
            await asyncio.Event().wait()
        return DeliveryAuthority(role=WorkspaceRole.member)

    sessions = Sessions()
    _install(monkeypatch, sessions, query)
    monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 0)
    first = asyncio.create_task(read_delivery_authority(_principal()))
    after = None
    try:
        await finished(first, "the timed-out read never answered")
        assert first.result().close_code == TRY_AGAIN

        monkeypatch.setattr(authority_module, "AUTHORITY_READ_TIMEOUT_SECONDS", 3)
        after = asyncio.create_task(read_delivery_authority(_principal()))
        await finished(after, "the permit was not released after an ordinary timeout")
        assert after.result().close_code is None
        assert sessions.entered == [1, 2]
        assert not authority_module._read_slots().locked()
        assert _authority_errors(caplog) == []
    finally:
        await reap(first, after, *sessions.close_tasks)
