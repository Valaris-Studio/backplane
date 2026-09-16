# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fix 6: listener-health observability.

The postgres backend's cross-instance delivery hinges on a live LISTEN
connection that can drop silently. Surface its liveness:
  - AsyncpgNotifyTransport.is_connected  (conn open?)
  - PostgresEventBus.listener_connected   (bus-level view; memory bus -> None)
  - /health exposes event_bus{backend, listener_connected}, cheap + never raising.
"""

import uuid

from app.core.event_bus import (
    AsyncpgNotifyTransport,
    EventBus,
    PostgresEventBus,
)


class FakeTransport:
    def __init__(self):
        self._connected = False

    async def start(self):
        pass

    async def stop(self):
        pass

    async def listen(self, channel, callback):
        self._connected = True

    async def notify(self, channel, payload):
        pass

    @property
    def is_connected(self):
        return self._connected


def test_transport_is_connected_false_before_listen():
    transport = AsyncpgNotifyTransport("postgresql://x")
    assert transport.is_connected is False


def test_memory_bus_has_no_listener_connected():
    bus = EventBus()
    # Memory bus exposes None/absent -- there is no listener to be connected.
    assert getattr(bus, "listener_connected", None) is None


async def test_postgres_bus_listener_connected_reflects_transport():
    transport = FakeTransport()
    bus = PostgresEventBus(transport=transport, channel="c")
    assert bus.listener_connected is False
    await bus.start()
    assert bus.listener_connected is True
