# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fix 1: remote events must not re-deliver origin-only side effects.

Every gunicorn worker runs a WebhookSubscriber subscribed to "*". A remote
NOTIFY re-injected via _dispatch_local reaches EVERY local subscriber, including
WebhookSubscriber -- so one logical event fires an external webhook POST per
worker across the fleet. The originating worker already delivered it; the fan-out
of a remote event is meant for the WS layer (ConnectionManager) only.

The seam: Event.remote is True for events reconstructed from a remote NOTIFY.
Origin-only subscribers (webhook delivery) skip remote events; WS delivery does not.
"""

import uuid

from unittest.mock import AsyncMock, MagicMock, patch

from app.core.event_bus import Event, PostgresEventBus
from app.services.events.webhook_subscriber import WebhookSubscriber


class FakeTransport:
    def __init__(self, hub):
        self._hub = hub
        self._callback = None
        self._channel = None

    async def start(self):
        pass

    async def stop(self):
        pass

    async def listen(self, channel, callback):
        self._channel = channel
        self._callback = callback
        self._hub.setdefault(channel, []).append(self)

    async def notify(self, channel, payload):
        for transport in self._hub.get(channel, []):
            if transport._callback is not None:
                await transport._callback(payload)


def _make_bus(hub):
    return PostgresEventBus(transport=FakeTransport(hub), channel="valaris_events")


def _webhook_factory():
    """Mimic the async_sessionmaker chain the real WebhookSubscriber expects."""
    mock_session = AsyncMock()
    begin_ctx = AsyncMock()
    begin_ctx.__aenter__ = AsyncMock()
    begin_ctx.__aexit__ = AsyncMock(return_value=False)
    mock_session.begin = MagicMock(return_value=begin_ctx)
    session_ctx = AsyncMock()
    session_ctx.__aenter__ = AsyncMock(return_value=mock_session)
    session_ctx.__aexit__ = AsyncMock(return_value=False)
    return MagicMock(return_value=session_ctx)


def test_event_remote_defaults_false():
    evt = Event(event_type="card.created", workspace_id=uuid.uuid4(), payload={})
    assert evt.remote is False


async def test_on_notification_builds_remote_event():
    import json

    hub = {}
    bus = _make_bus(hub)
    captured = {}

    async def capture(evt):
        captured["evt"] = evt

    bus.subscribe(capture, event_pattern="*")
    await bus.start()
    # A remote NOTIFY from another instance (distinct origin_id) is re-injected.
    raw = json.dumps(
        {
            "event_type": "card.moved",
            "workspace_id": str(uuid.uuid4()),
            "payload": {"card_id": "c1"},
            "timestamp": "2026-07-23T00:00:00+00:00",
            "event_id": str(uuid.uuid4()),
            "origin_id": "some-other-instance",
            "thin": False,
        }
    )
    await bus._on_notification(raw)

    assert captured["evt"].remote is True


async def test_webhook_subscriber_skips_remote_events():
    # A remote event must NOT trigger an external webhook POST (origin worker
    # already delivered it). One logical publish = one webhook delivery fleet-wide.
    bus = PostgresEventBus(transport=FakeTransport({}), channel="c")
    factory = _webhook_factory()
    subscriber = WebhookSubscriber(bus, factory)
    subscriber.start()

    ws = uuid.uuid4()
    remote_evt = Event(event_type="card.created", workspace_id=ws, payload={}, remote=True)

    with patch("app.services.events.webhook_subscriber.EventEmitter") as MockEmitter:
        mock_emitter = AsyncMock()
        MockEmitter.return_value = mock_emitter
        await subscriber._handle_event(remote_evt)
        MockEmitter.assert_not_called()  # remote → no external delivery


async def test_webhook_subscriber_delivers_local_events():
    bus = PostgresEventBus(transport=FakeTransport({}), channel="c")
    factory = _webhook_factory()
    subscriber = WebhookSubscriber(bus, factory)
    subscriber.start()

    ws = uuid.uuid4()
    local_evt = Event(event_type="card.created", workspace_id=ws, payload={"x": 1})

    with patch("app.services.events.webhook_subscriber.EventEmitter") as MockEmitter:
        mock_emitter = AsyncMock()
        MockEmitter.return_value = mock_emitter
        await subscriber._handle_event(local_evt)
        mock_emitter.emit.assert_awaited_once()  # local → delivered


async def test_two_bus_fleet_one_webhook_delivery_ws_still_fans():
    # Fleet simulation: two instances share a transport hub. Publish on A.
    # WebhookSubscriber on BOTH A and B is subscribed "*"; only A's fires
    # (origin-only). A plain WS-style subscriber on B DOES fire (that's the
    # whole point of the cross-instance bus).
    hub = {}
    bus_a = _make_bus(hub)
    bus_b = _make_bus(hub)
    await bus_a.start()
    await bus_b.start()

    webhook_hits = {"a": 0, "b": 0}

    async def webhook_a(evt):
        if not evt.remote:
            webhook_hits["a"] += 1

    async def webhook_b(evt):
        if not evt.remote:
            webhook_hits["b"] += 1

    ws_hits_b = {"n": 0}

    async def ws_b(evt):
        ws_hits_b["n"] += 1  # WS delivers remote events too

    bus_a.subscribe(webhook_a, event_pattern="*")
    bus_b.subscribe(webhook_b, event_pattern="*")
    bus_b.subscribe(ws_b, event_pattern="*")

    import asyncio

    await bus_a.publish("card.created", {"id": "1"}, uuid.uuid4())
    await asyncio.sleep(0)

    assert webhook_hits["a"] == 1  # origin worker delivered
    assert webhook_hits["b"] == 0  # remote worker skipped its webhook
    assert ws_hits_b["n"] == 1  # remote worker's WS layer still received it

    await bus_a.stop()
    await bus_b.stop()
