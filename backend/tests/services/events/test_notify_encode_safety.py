# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fix 5: encoding a non-serializable payload must not raise into publish().

_encode (json.dumps) ran OUTSIDE the try in _notify, so a payload carrying a
raw UUID / datetime would raise straight into the service caller -- breaking the
memory bus's never-raises publish contract when running on the postgres backend.
"""

import logging
import uuid

from app.core.event_bus import PostgresEventBus


class FakeTransport:
    def __init__(self):
        self.sent = []

    async def start(self):
        pass

    async def stop(self):
        pass

    async def listen(self, channel, callback):
        pass

    async def notify(self, channel, payload):
        self.sent.append(payload)


async def test_publish_with_non_serializable_payload_does_not_raise(caplog):
    transport = FakeTransport()
    bus = PostgresEventBus(transport=transport, channel="c")
    await bus.start()

    # A raw UUID is not JSON-serializable by default (no str coercion).
    with caplog.at_level(logging.ERROR):
        await bus.publish("card.created", {"card_id": uuid.uuid4()}, uuid.uuid4())
    # Contract: publish never raises. Either it logs and skips, or default=str
    # serializes it -- both acceptable, the caller must be unaffected.
