# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card 40424fb3 — runner liveness derivation + transition events.

Liveness is derived from `last_seen_at` rather than persisted as a separate
column. This avoids a schema migration and keeps the source of truth in the
heartbeat timestamp the agent already writes. The scan task acts as the
backup signal that surfaces the *absence* of a heartbeat after the threshold
elapses (the primary signal is heartbeat-stops-arriving).
"""

from datetime import timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import AGENT_STATUS_CHANGED
from app.models.agents.agent import Agent
from app.services.agents.agent import AgentService
from app.services.agents.liveness import (
    ALIVE_THRESHOLD_SECONDS,
    OFFLINE_THRESHOLD_SECONDS,
    LivenessTracker,
    compute_liveness,
)
from app.utils import utcnow


def test_compute_liveness_alive_within_threshold():
    last_seen = utcnow() - timedelta(seconds=30)
    assert compute_liveness(last_seen) == "alive"


def test_compute_liveness_stale_after_threshold():
    last_seen = utcnow() - timedelta(seconds=ALIVE_THRESHOLD_SECONDS + 30)
    assert compute_liveness(last_seen) == "stale"


def test_compute_liveness_offline_after_offline_threshold():
    last_seen = utcnow() - timedelta(seconds=OFFLINE_THRESHOLD_SECONDS + 100)
    assert compute_liveness(last_seen) == "offline"


def test_compute_liveness_unknown_when_never_seen():
    assert compute_liveness(None) == "unknown"


def test_compute_liveness_respects_custom_thresholds():
    last_seen = utcnow() - timedelta(seconds=10)
    # Tight thresholds let callers tune for tests / different SLOs.
    assert compute_liveness(last_seen, alive_threshold=5, offline_threshold=20) == "stale"
    assert compute_liveness(last_seen, alive_threshold=5, offline_threshold=8) == "offline"


async def test_handle_ws_heartbeat_payload_includes_liveness(
    db_session: AsyncSession, test_agent: Agent, test_workspace
):
    received: list[dict] = []

    async def _capture(event):
        received.append(event.payload)

    unsub = event_bus.subscribe(
        callback=_capture,
        workspace_id=test_workspace.id,
        event_pattern="agent.heartbeat_received",
    )
    try:
        await AgentService(db_session).handle_ws_heartbeat(
            test_agent.id, {"status": "idle"}, workspace_id=test_workspace.id
        )
        # A heartbeat was just received — by definition the agent is alive.
        assert any(p.get("liveness") == "alive" for p in received)
    finally:
        unsub()


async def test_scan_stale_agents_emits_event_for_stale_transition(
    db_session: AsyncSession, test_agent: Agent, test_workspace
):
    # Make the agent visible to the workspace so liveness scan can resolve a
    # workspace_id and publish the transition event.
    test_agent.allowed_workspaces = [test_workspace.slug]
    test_agent.last_seen_at = utcnow() - timedelta(
        seconds=ALIVE_THRESHOLD_SECONDS + 30
    )
    await db_session.flush()

    received: list[dict] = []

    async def _capture(event):
        received.append(event.payload)

    unsub = event_bus.subscribe(
        callback=_capture,
        workspace_id=test_workspace.id,
        event_pattern=AGENT_STATUS_CHANGED,
    )
    try:
        tracker = LivenessTracker()
        # Seed prior liveness as "alive" to force a transition.
        tracker.seed(test_agent.id, "alive")
        transitions = await tracker.scan_and_publish(db_session, event_bus)
        assert transitions == 1
        assert any(
            p.get("agent_id") == str(test_agent.id)
            and p.get("liveness") == "stale"
            and p.get("previous_liveness") == "alive"
            for p in received
        )
    finally:
        unsub()


async def test_scan_stale_agents_idempotent(
    db_session: AsyncSession, test_agent: Agent, test_workspace
):
    test_agent.allowed_workspaces = [test_workspace.slug]
    test_agent.last_seen_at = utcnow() - timedelta(
        seconds=ALIVE_THRESHOLD_SECONDS + 30
    )
    await db_session.flush()

    received: list[dict] = []

    async def _capture(event):
        received.append(event.payload)

    unsub = event_bus.subscribe(
        callback=_capture,
        workspace_id=test_workspace.id,
        event_pattern=AGENT_STATUS_CHANGED,
    )
    try:
        tracker = LivenessTracker()
        tracker.seed(test_agent.id, "alive")
        first = await tracker.scan_and_publish(db_session, event_bus)
        # Same scan again — no change in last_seen_at, so no new transition.
        second = await tracker.scan_and_publish(db_session, event_bus)
        assert first == 1
        assert second == 0
        # Only the first scan emitted an event.
        stale_events = [p for p in received if p.get("liveness") == "stale"]
        assert len(stale_events) == 1
    finally:
        unsub()
