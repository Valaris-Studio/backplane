# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PostgresEventBus transport-level tests.

The integration suite runs on in-process SQLite (aiosqlite), which has NO
LISTEN/NOTIFY (plan §6.7). So we exercise the adapter against an in-memory
FAKE transport that mimics Postgres LISTEN/NOTIFY semantics: a NOTIFY on one
bus is fanned out (as raw JSON strings) to every listener registered on the
same channel, including the publisher's own listener (the real Postgres echo).

This covers exactly the logic the plan flags as subtle: encode/decode of the
envelope, per-process origin suppression (no double-delivery on the publisher),
local-only re-injection (no NOTIFY echo loop), and the 8KB thin-fallback.
"""

import asyncio
import json
import uuid

from unittest.mock import AsyncMock

from app.core.event_bus import Event, PostgresEventBus


class FakeTransport:
    """Mimics Postgres LISTEN/NOTIFY: NOTIFY delivers the raw payload to every
    listener on the channel (the publisher included — Postgres echoes to the
    publishing connection too)."""

    def __init__(self, hub):
        self._hub = hub
        self._callback = None
        self._channel = None
        self.started = False
        self.stopped = False

    async def start(self):
        self.started = True

    async def stop(self):
        self.stopped = True

    async def listen(self, channel, callback):
        self._channel = channel
        self._callback = callback
        self._hub.setdefault(channel, []).append(self)

    async def notify(self, channel, payload):
        for transport in self._hub.get(channel, []):
            if transport._callback is not None:
                await transport._callback(payload)


def make_bus(hub, channel="valaris_events"):
    transport = FakeTransport(hub)
    bus = PostgresEventBus(transport=transport, channel=channel)
    return bus, transport


async def test_publish_delivers_locally():
    bus, _ = make_bus({})
    await bus.start()
    cb = AsyncMock()
    ws = uuid.uuid4()
    bus.subscribe(cb, workspace_id=ws, event_pattern="card.*")

    await bus.publish("card.created", {"id": "1"}, ws)

    cb.assert_awaited_once()
    evt: Event = cb.call_args[0][0]
    assert evt.event_type == "card.created"
    assert evt.payload == {"id": "1"}
    await bus.stop()


async def test_publish_does_not_double_deliver_to_publisher():
    # The publisher delivers locally AND its own NOTIFY echoes back through its
    # listener. Origin suppression must drop the echo so the local subscriber
    # fires exactly once.
    hub = {}
    bus, _ = make_bus(hub)
    await bus.start()
    cb = AsyncMock()
    ws = uuid.uuid4()
    bus.subscribe(cb, workspace_id=ws, event_pattern="*")

    await bus.publish("card.moved", {"id": "9"}, ws)
    await asyncio.sleep(0)  # let any echoed task drain

    cb.assert_awaited_once()
    await bus.stop()


async def test_remote_event_reaches_other_instance():
    # Two buses, same channel/DB. Publish on A, subscriber on B fires.
    hub = {}
    bus_a, _ = make_bus(hub)
    bus_b, _ = make_bus(hub)
    await bus_a.start()
    await bus_b.start()

    cb_b = AsyncMock()
    ws = uuid.uuid4()
    bus_b.subscribe(cb_b, workspace_id=ws, event_pattern="card.*")

    await bus_a.publish("card.created", {"id": "42"}, ws)
    await asyncio.sleep(0)

    cb_b.assert_awaited_once()
    evt: Event = cb_b.call_args[0][0]
    assert evt.event_type == "card.created"
    assert evt.workspace_id == ws
    assert evt.payload == {"id": "42"}
    await bus_a.stop()
    await bus_b.stop()


async def test_remote_event_preserves_event_id_and_workspace():
    hub = {}
    bus_a, _ = make_bus(hub)
    bus_b, _ = make_bus(hub)
    await bus_a.start()
    await bus_b.start()
    captured = {}

    async def capture(evt):
        captured["evt"] = evt

    ws = uuid.uuid4()
    bus_b.subscribe(capture, event_pattern="*")

    await bus_a.publish("approval.updated", {"k": "v"}, ws)
    await asyncio.sleep(0)

    assert captured["evt"].workspace_id == ws
    # event_id is carried across the wire so dedupe/keying is stable per logical event.
    assert isinstance(captured["evt"].event_id, uuid.UUID)
    await bus_a.stop()
    await bus_b.stop()


async def test_remote_injection_does_not_re_notify():
    # When bus B receives a remote event, it must do LOCAL fan-out only — never
    # re-NOTIFY (which would loop forever across the two instances). We assert
    # the receiving bus issues no further notifies on its transport.
    hub = {}
    bus_a, _ = make_bus(hub)
    bus_b, transport_b = make_bus(hub)
    await bus_a.start()
    await bus_b.start()

    notify_count = {"n": 0}
    original_notify = transport_b.notify

    async def counting_notify(channel, payload):
        notify_count["n"] += 1
        await original_notify(channel, payload)

    transport_b.notify = counting_notify

    bus_b.subscribe(AsyncMock(), event_pattern="*")
    await bus_a.publish("card.created", {"id": "1"}, uuid.uuid4())
    await asyncio.sleep(0)

    assert notify_count["n"] == 0  # B never re-emitted
    await bus_a.stop()
    await bus_b.stop()


async def test_oversized_payload_falls_back_to_thin_notification():
    # §6.3: NOTIFY caps at ~8000 bytes. A full envelope over the cap is sent as
    # a THIN form (event_type + entity ids + workspace_id, marked thin) so the
    # receiver knows to refetch. The big snapshot fields are dropped from the wire.
    hub = {}
    bus_a, transport_a = make_bus(hub)
    bus_b, _ = make_bus(hub)
    await bus_a.start()
    await bus_b.start()

    sent_payloads = []
    original_notify = transport_a.notify

    async def spy_notify(channel, payload):
        sent_payloads.append(payload)
        await original_notify(channel, payload)

    transport_a.notify = spy_notify

    ws = uuid.uuid4()
    received = {}

    async def capture(evt):
        received["evt"] = evt

    bus_b.subscribe(capture, event_pattern="*")

    big = "x" * 9000
    await bus_a.publish(
        "card.updated",
        {"card_id": "c-1", "board_id": "b-1", "after_state": {"description": big}},
        ws,
    )
    await asyncio.sleep(0)

    assert len(sent_payloads) == 1
    on_wire = json.loads(sent_payloads[0])
    assert len(sent_payloads[0]) <= 8000  # within the NOTIFY cap
    assert on_wire.get("thin") is True
    # The huge snapshot is stripped from the wire.
    assert "after_state" not in on_wire.get("payload", {})
    # Entity ids that let the receiver refetch survive.
    assert on_wire["payload"].get("card_id") == "c-1"
    assert on_wire["payload"].get("board_id") == "b-1"

    # Receiver still gets an event it can act on (flagged thin → refetch).
    assert received["evt"].event_type == "card.updated"
    assert received["evt"].workspace_id == ws
    assert received["evt"].payload.get("_thin") is True
    await bus_a.stop()
    await bus_b.stop()


async def test_small_payload_sent_in_full():
    hub = {}
    bus_a, transport_a = make_bus(hub)
    bus_b, _ = make_bus(hub)
    await bus_a.start()
    await bus_b.start()

    sent = []
    original_notify = transport_a.notify

    async def spy_notify(channel, payload):
        sent.append(payload)
        await original_notify(channel, payload)

    transport_a.notify = spy_notify

    received = {}

    async def capture(evt):
        received["evt"] = evt

    bus_b.subscribe(capture, event_pattern="*")
    await bus_a.publish("card.created", {"card_id": "c-1", "title": "Hello"}, uuid.uuid4())
    await asyncio.sleep(0)

    on_wire = json.loads(sent[0])
    assert on_wire.get("thin") in (False, None)
    assert received["evt"].payload == {"card_id": "c-1", "title": "Hello"}
    await bus_a.stop()
    await bus_b.stop()


async def test_start_and_stop_drive_transport_lifecycle():
    hub = {}
    bus, transport = make_bus(hub)
    await bus.start()
    assert transport.started is True
    await bus.stop()
    assert transport.stopped is True


async def test_malformed_remote_payload_is_ignored():
    # A garbage NOTIFY (decode failure) must not crash the listener or stop
    # delivery of subsequent good events.
    hub = {}
    bus_a, transport_a = make_bus(hub)
    bus_b, _ = make_bus(hub)
    await bus_a.start()
    await bus_b.start()
    cb = AsyncMock()
    bus_b.subscribe(cb, event_pattern="*")

    # Inject raw garbage straight onto B's listener (simulating a bad NOTIFY).
    await transport_a.notify("valaris_events", "{not valid json")
    await asyncio.sleep(0)
    cb.assert_not_awaited()  # garbage ignored, no crash

    await bus_a.publish("card.created", {"id": "1"}, uuid.uuid4())
    await asyncio.sleep(0)
    cb.assert_awaited_once()  # good event still flows
    await bus_a.stop()
    await bus_b.stop()
