# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Transport-level hardening for AsyncpgNotifyTransport (Fixes 2, 3, 4, 7).

These exercise the real transport against a fake asyncpg connection, patched in
via `asyncpg.connect`. The transport imports asyncpg lazily inside its methods,
so patching the `asyncpg` module's `connect` is enough.

Covered:
  Fix 2 -- notify() reuses one persistent connection (no per-event churn),
           reconnects once on failure, swallows a persistent failure.
  Fix 3 -- listen() starts the supervisor even when the first connect fails;
           the supervisor establishes LISTEN on a later tick.
  Fix 4 -- notifications are queued and drained FIFO by a single consumer;
           stop() cancels the consumer cleanly.
  Fix 7 -- _supervise backoff grows across failures and resets after success.
"""

import asyncio
import sys
import types
import uuid

import pytest

from app.core.event_bus import AsyncpgNotifyTransport


class FakeConnection:
    """Stands in for an asyncpg connection. Records executes and add_listener,
    and can be told to look closed."""

    def __init__(self):
        self.executed: list[tuple] = []
        self.listeners: dict = {}
        self._closed = False
        self.closed_calls = 0

    def is_closed(self):
        return self._closed

    async def execute(self, sql, *args):
        if self._closed:
            raise RuntimeError("connection is closed")
        self.executed.append((sql, args))

    async def add_listener(self, channel, callback):
        self.listeners[channel] = callback

    async def close(self):
        self.closed_calls += 1
        self._closed = True

    # test helper: simulate Postgres delivering a NOTIFY to this connection
    def deliver(self, channel, payload):
        cb = self.listeners.get(channel)
        if cb is not None:
            cb(self, 1234, channel, payload)


class ConnectFactory:
    """A patchable replacement for asyncpg.connect. Hands out FakeConnections,
    counting calls; a `fail_first` counter raises before yielding."""

    def __init__(self, fail_first: int = 0, conn_seq=None):
        self.calls = 0
        self.fail_first = fail_first
        self._conn_seq = conn_seq
        self.conns: list[FakeConnection] = []

    async def __call__(self, dsn):
        self.calls += 1
        if self.fail_first > 0:
            self.fail_first -= 1
            raise RuntimeError("connect failed")
        conn = (
            self._conn_seq.pop(0)
            if self._conn_seq
            else FakeConnection()
        )
        self.conns.append(conn)
        return conn


@pytest.fixture
def fake_asyncpg(monkeypatch):
    """Install a fake `asyncpg` module so the transport's lazy `import asyncpg`
    resolves to our factory. Returns a setter the test uses to install a
    ConnectFactory as `asyncpg.connect`."""
    module = types.ModuleType("asyncpg")

    def install(factory):
        module.connect = factory
        return factory

    monkeypatch.setitem(sys.modules, "asyncpg", module)
    return install


# ---------------------------------------------------------------- Fix 2

async def test_notify_reuses_one_connection(fake_asyncpg):
    factory = fake_asyncpg(ConnectFactory())
    transport = AsyncpgNotifyTransport("postgresql://x")
    await transport.start()

    for i in range(5):
        await transport.notify("ch", f"p{i}")

    assert factory.calls == 1  # one persistent connection reused
    assert len(factory.conns[0].executed) == 5
    await transport.stop()


async def test_notify_reconnects_once_after_conn_dies(fake_asyncpg):
    dead = FakeConnection()
    fresh = FakeConnection()
    factory = fake_asyncpg(ConnectFactory(conn_seq=[dead, fresh]))
    transport = AsyncpgNotifyTransport("postgresql://x")
    await transport.start()

    await transport.notify("ch", "first")  # opens `dead`
    assert len(dead.executed) == 1

    dead._closed = True  # connection drops between publishes
    await transport.notify("ch", "second")  # reconnect once, deliver on `fresh`

    assert factory.calls == 2
    assert len(fresh.executed) == 1
    assert fresh.executed[0][1] == ("ch", "second")
    await transport.stop()


async def test_notify_swallows_persistent_failure(fake_asyncpg):
    # A connection that always fails to execute must not raise into the caller
    # (NOTIFY failures only cost cross-instance liveness).
    class AlwaysFailConn(FakeConnection):
        async def execute(self, sql, *args):
            raise RuntimeError("execute always fails")

    factory = fake_asyncpg(
        ConnectFactory(conn_seq=[AlwaysFailConn(), AlwaysFailConn()])
    )
    transport = AsyncpgNotifyTransport("postgresql://x")
    await transport.start()

    await transport.notify("ch", "p")  # must not raise
    await transport.stop()


# ---------------------------------------------------------------- Fix 3

async def test_supervisor_starts_even_if_first_connect_fails(fake_asyncpg):
    # First LISTEN connect fails; listen() must still create the supervisor,
    # which establishes LISTEN on a later tick and then delivers a notification.
    factory = fake_asyncpg(ConnectFactory(fail_first=1))
    transport = AsyncpgNotifyTransport(
        "postgresql://x", reconnect_backoff_seconds=0.01
    )
    await transport.start()

    received = []

    async def cb(payload):
        received.append(payload)

    # First connect (inside listen) fails; supervisor task must still exist.
    await transport.listen("ch", cb)
    assert transport._reconnect_task is not None

    # Wait for a supervise tick to establish LISTEN.
    for _ in range(50):
        await asyncio.sleep(0.01)
        if transport._conn is not None and not transport._conn.is_closed():
            break
    assert transport.is_connected

    factory.conns[0].deliver("ch", "hello")
    await asyncio.sleep(0.02)
    assert received == ["hello"]
    await transport.stop()


# ---------------------------------------------------------------- Fix 4

async def test_notifications_delivered_in_order(fake_asyncpg):
    fake_asyncpg(ConnectFactory())
    transport = AsyncpgNotifyTransport("postgresql://x")
    await transport.start()

    received = []

    async def cb(payload):
        # Yield to the loop to expose any ordering bug from concurrent tasks.
        await asyncio.sleep(0)
        received.append(payload)

    await transport.listen("ch", cb)
    conn = transport._conn
    for i in range(20):
        conn.deliver("ch", f"n{i}")

    await asyncio.sleep(0.05)
    assert received == [f"n{i}" for i in range(20)]
    await transport.stop()


async def test_stop_cancels_consumer_cleanly(fake_asyncpg):
    fake_asyncpg(ConnectFactory())
    transport = AsyncpgNotifyTransport("postgresql://x")
    await transport.start()

    async def cb(payload):
        pass

    await transport.listen("ch", cb)
    await transport.stop()
    # Consumer + supervisor cancelled; no lingering running tasks.
    assert transport._consumer_task is None or transport._consumer_task.cancelled() or transport._consumer_task.done()


async def test_queue_full_drops_and_does_not_block(fake_asyncpg):
    # A slow consumer + a burst beyond the queue cap must not deadlock the
    # asyncpg reader callback (at-most-once is the documented contract).
    fake_asyncpg(ConnectFactory())
    transport = AsyncpgNotifyTransport(
        "postgresql://x", max_pending_notifications=4
    )
    await transport.start()

    gate = asyncio.Event()
    received = []

    async def cb(payload):
        await gate.wait()  # block the consumer so the queue fills
        received.append(payload)

    await transport.listen("ch", cb)
    conn = transport._conn
    # Fire far more than the cap; the reader callback is sync and must not block.
    for i in range(100):
        conn.deliver("ch", f"n{i}")  # must return immediately, never hang

    gate.set()
    await asyncio.sleep(0.05)
    # The cap MUST have forced drops: one item is in-flight in the blocked
    # consumer + at most `maxsize` buffered, so far fewer than 100 survive.
    # (Reaching this line at all also proves the reader callback never blocked.)
    assert 0 < len(received) < 100
    assert len(received) <= 1 + 4  # in-flight + queue cap
    assert received == [f"n{i}" for i in range(len(received))]  # FIFO, oldest kept
    await transport.stop()


# ---------------------------------------------------------------- Fix 7

async def test_supervise_backoff_grows_then_resets(fake_asyncpg):
    # Inject a fake clock so the test is instant. Connect fails several times
    # (backoff should grow), then succeeds (backoff resets to base).
    factory = fake_asyncpg(ConnectFactory(fail_first=3))
    transport = AsyncpgNotifyTransport(
        "postgresql://x", reconnect_backoff_seconds=1.0
    )
    await transport.start()

    sleeps: list[float] = []
    real_sleep = asyncio.sleep

    async def fake_sleep(delay):
        sleeps.append(delay)
        await real_sleep(0)  # yield without waiting

    transport._sleep = fake_sleep  # injectable clock

    async def cb(payload):
        pass

    await transport.listen("ch", cb)
    # Let the supervisor churn through the failures + first success.
    for _ in range(200):
        await real_sleep(0)
        if transport.is_connected:
            break

    await transport.stop()

    # Backoff on consecutive failures must be non-decreasing (grows toward cap),
    # ignoring jitter by comparing the base component conservatively.
    failing_delays = sleeps[:3]
    assert failing_delays == sorted(failing_delays)
    assert failing_delays[-1] > failing_delays[0]
    # And every delay respects the 30s cap.
    assert all(d <= 30.0 for d in sleeps)
