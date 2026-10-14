# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Shared, test-only observation for authority sessions and owned tasks."""

import asyncio
from contextlib import asynccontextmanager

BOUND = 2


class SessionTracker:
    """A stand-in for `database.async_session` that records the lifecycle the
    production reader must honor: every entered session is exited (its async
    __aexit__ awaited), including when a deadline cancels the read."""

    def __init__(self):
        self.active = 0
        self.peak = 0
        self.entered = 0
        self.exited = 0
        self.cancelled = 0
        # Set when a session starts its async exit; with stall_exits(), the
        # exit then waits on the returned gate (a real suspension).
        self.exit_started = asyncio.Event()
        self._exit_gate: asyncio.Event | None = None

    def stall_exits(self) -> asyncio.Event:
        """Hold every session exit open until the returned event is set."""
        self._exit_gate = asyncio.Event()
        return self._exit_gate

    def __call__(self):
        return self._session()

    @asynccontextmanager
    async def _session(self):
        self.entered += 1
        self.active += 1
        self.peak = max(self.peak, self.active)
        try:
            yield object()
        except asyncio.CancelledError:
            self.cancelled += 1
            raise
        finally:
            await self._release_connection()
            self.active -= 1
            self.exited += 1

    async def _release_connection(self):
        # Stands in for the session's own async close: prompt by default, or
        # suspended until the stall_exits() gate opens.
        self.exit_started.set()
        if self._exit_gate is not None:
            await self._exit_gate.wait()


async def finished(task, message):
    """Wait (bounded, without cancelling) for a task the code under test owns,
    and fail with `message` at this assertion if it is still running."""
    done, _ = await asyncio.wait({task}, timeout=BOUND)
    assert task in done, message


async def reap(*tasks):
    """Teardown for expected-RED runs: cancel whatever is left, wait (bounded)
    for it to finish, and fail if any task ignored the cancellation. This does
    not prove an uncooperative task can be stopped, only that every task here
    cooperated within the bound. Exceptions of tasks that finished on their own
    are retrieved, so they cannot surface later as unretrieved errors."""
    owned = [t for t in tasks if t is not None]
    leftovers = [t for t in owned if not t.done()]
    for task in leftovers:
        task.cancel()
    if leftovers:
        _, pending = await asyncio.wait(leftovers, timeout=BOUND)
        assert not pending, f"{len(pending)} task(s) did not finish after cancellation"
    for task in owned:
        if task.done() and not task.cancelled():
            task.exception()
