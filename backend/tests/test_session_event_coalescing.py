# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio

from app.core.event_bus import event_bus
from app.services.committed_events import queue_until_commit


async def test_generic_identical_committed_events_are_not_coalesced(
    db_session, test_workspace
):
    observed = []
    completed = asyncio.Event()

    async def receive(event):
        observed.append(event.payload)
        if event.payload.get("tail"):
            completed.set()

    unsubscribe = event_bus.subscribe(
        receive,
        workspace_id=test_workspace.id,
        event_pattern="test.relationship.generic",
    )
    try:
        payload = {"changes": {"before": [1], "after": [2]}}
        for _ in range(2):
            queue_until_commit(
                db_session, "test.relationship.generic", payload, test_workspace.id
            )
        queue_until_commit(
            db_session,
            "test.relationship.generic",
            {"tail": True},
            test_workspace.id,
        )
        assert observed == []
        await db_session.commit()
        await asyncio.wait_for(completed.wait(), timeout=1)
        assert observed == [payload, payload, {"tail": True}]
    finally:
        unsubscribe()
