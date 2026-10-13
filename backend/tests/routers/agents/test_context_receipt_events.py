# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Receipt notification follows the outer transaction, never the HTTP flush."""

import asyncio
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from app.core.event_bus import Event, event_bus
from app.database import get_db
from app.main import create_app
from tests.routers.agents.context_receipts_support import _receipt_case_fixture  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


@pytest.mark.parametrize("outcome", ["commit", "rollback"])
async def test_receipt_created_event_follows_outer_commit_and_never_exact_replay(receipt_case, outcome):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    path = case.execution_path(execution["id"]) + "/context-receipts"
    payload = case.receipt_payload(assignment)
    published: list[Event] = []
    delivered = asyncio.Event()

    async def receive(event):
        published.append(event)
        delivered.set()

    unsubscribe = event_bus.subscribe(
        receive, workspace_id=uuid.UUID(case.workspace["id"]),
        event_pattern="execution.context_receipt_created",
    )
    try:
        async with case.factory() as db:
            app = create_app()

            async def outer_transaction():
                # The test owns the outer boundary. The real auth/router/
                # service still flushes normally, but must not commit it.
                yield db

            app.dependency_overrides[get_db] = outer_transaction
            async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
                response = await http.post(path, json=payload, headers=case.headers["agent"])
            assert response.status_code == 201, response.text
            receipt = response.json()
            assert db.in_transaction(), "Receipt service stole the caller's transaction"
            await asyncio.sleep(0.01)
            assert published == [], "Receipt notification escaped before the outer commit"
            if outcome == "commit":
                await db.commit()
            else:
                await db.rollback()

        if outcome == "rollback":
            await asyncio.sleep(0.01)
            assert published == []
            missing = await case.receipt(execution, receipt["id"])
            assert missing.status_code == 404
            retry = await case.http.post(path, json=payload, headers=case.headers["agent"])
            assert retry.status_code == 201, retry.text
            receipt = retry.json()
        await asyncio.wait_for(delivered.wait(), timeout=1)
        assert len(published) == 1
        event = published[0]
        assert event.workspace_id == uuid.UUID(case.workspace["id"])
        assert event.payload == {
            "execution_id": execution["id"], "workspace_id": case.workspace["id"],
            "receipt_id": receipt["id"], "ordinal": receipt["ordinal"],
        }
        assert (await case.receipt(execution, receipt["id"])).status_code == 200
        replay = await case.http.post(path, json=payload, headers=case.headers["agent"])
        assert replay.status_code == 200 and replay.json()["id"] == receipt["id"]
        await asyncio.sleep(0.01)
        assert len(published) == 1, "Exact replay must not announce another invocation"
    finally:
        unsubscribe()
