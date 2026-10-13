# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
from unittest.mock import AsyncMock

from app.main import create_app


async def test_application_runs_and_drains_history_preparation_worker(monkeypatch):
    """A durable queued window must progress without another browser request."""
    from app.services import timeline

    started = asyncio.Event()
    stopped = asyncio.Event()

    async def prepare():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    monkeypatch.setattr(timeline, "process_pending_timeline_preparations", prepare)
    # Isolate this lifecycle contract from unrelated workers and external services.
    for target in (
        "app.services.agents.liveness.LivenessTracker.scan_and_publish",
        "app.services.merge_queue.run_merge_queue_tick",
        "app.services.kanban.reconciler.MergedPRReconciler.scan_once",
        "app.services.session_retention.SessionRetentionService.run_purge",
    ):
        monkeypatch.setattr(target, AsyncMock())

    application = create_app()
    async with application.router.lifespan_context(application):
        await asyncio.wait_for(started.wait(), timeout=0.5)
    assert stopped.is_set(), "Shutdown returned while the preparation worker was still active"
