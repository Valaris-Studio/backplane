# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: publishers never wait on delivery-time authority.

Publication often runs inside a caller-owned request transaction that already
holds a pooled connection. If publishing awaited each socket's authority read,
concurrent publishers could exhaust the small pool waiting on themselves.
"""

import asyncio
import uuid
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock

from fastapi import WebSocket

from app.core.event_bus import EventBus
from app.models.workspace import WorkspaceRole
from app.services.events import authority as authority_module
from app.services.events.authority import (
    DeliveryAuthority,
    DeliveryPrincipal,
    read_delivery_authority,
)
from app.services.events.connection_manager import ConnectionManager


def _socket():
    ws = AsyncMock(spec=WebSocket)
    ws.send_json = AsyncMock()
    ws.close = AsyncMock()
    return ws


async def test_publish_returns_while_the_authority_read_is_still_blocked():
    bus = EventBus()
    released = asyncio.Event()

    async def blocked_authority(principal):
        await released.wait()
        return DeliveryAuthority(role=WorkspaceRole.member)

    manager = ConnectionManager(bus, authority=blocked_authority)
    workspace_id = uuid.uuid4()
    ws = _socket()
    conn = await manager.connect(ws, workspace_id, uuid.uuid4())
    # Overlapping patterns: the event must still be authorized and sent once.
    await manager.update_subscriptions(conn, ["card.*", "*"])

    await asyncio.wait_for(bus.publish("card.created", {"id": "1"}, workspace_id), 1)
    ws.send_json.assert_not_awaited()

    released.set()
    await asyncio.wait_for(conn._outbox.join(), 1)
    assert ws.send_json.await_count == 1
    await manager.disconnect(conn)


async def test_authority_reads_never_hold_more_than_one_session(monkeypatch):
    active = 0
    peak = 0

    @asynccontextmanager
    async def counting_session():
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        try:
            await asyncio.sleep(0.01)
            yield object()
        finally:
            active -= 1

    async def granted(session, principal):
        return DeliveryAuthority(role=WorkspaceRole.member)

    monkeypatch.setattr(authority_module.database, "async_session", counting_session)
    monkeypatch.setattr(authority_module, "current_delivery_authority", granted)
    principals = [DeliveryPrincipal(workspace_id=uuid.uuid4(), user_id=uuid.uuid4())
                  for _ in range(20)]

    results = await asyncio.gather(*(read_delivery_authority(p) for p in principals))

    assert all(result.close_code is None for result in results)
    assert peak == 1
