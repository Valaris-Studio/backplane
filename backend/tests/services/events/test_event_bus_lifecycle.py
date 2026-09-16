# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Lifecycle helpers wired into app startup/shutdown (plan §4.4 lifecycle).

The cross-instance backend needs its LISTEN connection opened on startup and
closed on shutdown. The memory default has no such connection, so the helpers
must be a no-op for it -- the single-instance zero-config path stays untouched.
"""

from unittest.mock import AsyncMock

from app.core.event_bus import EventBus, start_event_bus, stop_event_bus


async def test_start_is_noop_for_memory_bus():
    # No start() attribute -> nothing to do, must not raise.
    await start_event_bus(EventBus())
    await stop_event_bus(EventBus())


async def test_start_calls_start_when_present():
    bus = AsyncMock()
    await start_event_bus(bus)
    bus.start.assert_awaited_once()


async def test_stop_calls_stop_when_present():
    bus = AsyncMock()
    await stop_event_bus(bus)
    bus.stop.assert_awaited_once()


async def test_start_swallows_backend_errors():
    # A failed LISTEN connect must not abort app startup -- local delivery and
    # HTTP still work; cross-instance liveness degrades and the supervisor retries.
    bus = AsyncMock()
    bus.start.side_effect = RuntimeError("pg down")
    await start_event_bus(bus)  # must not raise
