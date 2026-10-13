# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored PostgreSQL witness: delivery authority cannot starve
the production-shaped 3 + 2 pool while publishers hold every connection.

Uses the disposable per-test schema of the frozen PostgreSQL fixture; skipped
without CONTEXT_RECEIPT_TEST_DATABASE_URL.
"""

import asyncio
import os
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import WebSocket
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database
from app.core.event_bus import EventBus
from app.services.events.connection_manager import ConnectionManager
from tests.routers.agents.context_receipts_support import _receipt_case_fixture  # noqa: F401
from tests.routers.agents.test_context_receipts_postgres import db_engine as _db_engine_fixture

db_engine = _db_engine_fixture
pytestmark = [pytest.mark.slow, pytest.mark.timeout(60)]

# app/database.py: pool_size=3, max_overflow=2. The checkout timeout is cut
# from 30 s to 3 s only so a regression fails fast instead of stalling.
POOL_SIZE, POOL_OVERFLOW, POOL_TIMEOUT = 3, 2, 3
PUBLISHERS = POOL_SIZE + POOL_OVERFLOW
SOCKETS = 8
EVENTS_PER_PUBLISHER = 4


async def test_publishers_holding_every_pooled_connection_never_wait_on_delivery(
    receipt_case, db_engine, monkeypatch,
):
    case = receipt_case
    async with db_engine.connect() as connection:
        schema = await connection.scalar(text("SELECT current_schema()"))
    engine = create_async_engine(
        os.environ["CONTEXT_RECEIPT_TEST_DATABASE_URL"], hide_parameters=True,
        pool_size=POOL_SIZE, max_overflow=POOL_OVERFLOW, pool_timeout=POOL_TIMEOUT,
        connect_args={"server_settings": {"search_path": schema}},
    )
    factory = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    manager = ConnectionManager(EventBus())
    workspace_id = uuid.UUID(case.workspace["id"])
    sockets = []
    for _ in range(SOCKETS):
        ws = AsyncMock(spec=WebSocket)
        conn = await manager.connect(ws, workspace_id, uuid.UUID(case.recipient_id))
        await manager.update_subscriptions(conn, ["card.*"])
        sockets.append((ws, conn))

    publishers = [factory() for _ in range(PUBLISHERS)]
    try:
        # Every pooled connection is held by an open caller-owned transaction,
        # exactly like services publishing from inside a request.
        for session in publishers:
            await session.execute(text("SELECT 1"))
        assert engine.pool.checkedout() == PUBLISHERS

        async def publish_all(index):
            for n in range(EVENTS_PER_PUBLISHER):
                await manager._bus.publish("card.updated", {"p": index, "n": n}, workspace_id)

        await asyncio.wait_for(
            asyncio.gather(*(publish_all(i) for i in range(PUBLISHERS))), POOL_TIMEOUT - 1
        )
    finally:
        for session in publishers:
            await session.rollback()
            await session.close()

    try:
        for ws, conn in sockets:
            await asyncio.wait_for(conn._outbox.join(), 20)
            ws.close.assert_not_awaited()
            sent = [call.args[0]["payload"] for call in ws.send_json.await_args_list]
            assert len(sent) == PUBLISHERS * EVENTS_PER_PUBLISHER
            for index in range(PUBLISHERS):
                assert [p["n"] for p in sent if p["p"] == index] == list(range(EVENTS_PER_PUBLISHER))
    finally:
        for _, conn in sockets:
            await manager.disconnect(conn)
        await engine.dispose()
