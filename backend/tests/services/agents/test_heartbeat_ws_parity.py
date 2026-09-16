# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS-2.1 — schema parity between HTTP and WebSocket heartbeat paths.

Both paths must produce byte-equivalent agent state in the DB given the
same payload. This is the contract that keeps the deprecation window
safe: runner pairs running against a mismatched backend (HTTP) or a
newer backend (WS) produce identical downstream observations.

The WS path is implemented in the events router as a message type
`heartbeat` on the existing `/ws/workspaces/{slug}/events` socket. This
test bypasses the socket and exercises the same service entry point
(`AgentService.handle_ws_heartbeat`) to keep the assertion free of
transport concerns.
"""

from datetime import datetime
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.schemas.agents.agent import HeartbeatBody
from app.services.agents.agent import AgentService


CANONICAL_HEARTBEAT: dict[str, Any] = {
    "version": "1.2.3",
    "go_version": "go1.22.1",
    "hostname": "ci-runner-01",
    "started_at": "2026-04-15T10:00:00Z",
    "uptime_seconds": 7_200,
    "cards_processed": 12,
    "cards_failed": 1,
    "cards_skipped": 3,
    "status": "working",
    "current_card_id": "card-parity-1",
    "current_board_id": "board-parity-1",
    "last_error": "git push failed",
    "last_error_at": "2026-04-15T11:30:00Z",
    "poll_interval": "2m",
    "card_timeout": "30m",
    "health_port": 9090,
    "config_errors": [{"path": "pipeline.stages[0]", "message": "missing role"}],
    "sensor_catalog": [
        {
            "name": "go-test",
            "kind": "computational",
            "default_config": {"packages": "./..."},
            "description": "Runs Go tests.",
        }
    ],
    "loop_board_id": "board-parity-1",
    "loop_state": "parked",
    "loop_park_reason": "nothing actionable: 2 awaiting merge",
    "loop_parked_since": "2026-04-15T09:00:00Z",
}


def _snapshot(agent: Agent) -> dict[str, Any]:
    """Project the fields heartbeat mutates. Scalar values only so dict
    comparison is deterministic across backends."""
    return {
        "health_status": agent.health_status,
        "health_version": agent.health_version,
        "health_uptime_seconds": agent.health_uptime_seconds,
        "health_cards_processed": agent.health_cards_processed,
        "health_cards_failed": agent.health_cards_failed,
        "health_cards_skipped": agent.health_cards_skipped,
        "health_current_card_id": agent.health_current_card_id,
        "health_current_board_id": agent.health_current_board_id,
        "health_last_error": agent.health_last_error,
        "health_last_error_at": agent.health_last_error_at,
        "health_go_version": agent.health_go_version,
        "health_hostname": agent.health_hostname,
        "health_started_at": agent.health_started_at,
        "health_poll_interval": agent.health_poll_interval,
        "health_card_timeout": agent.health_card_timeout,
        "health_port": agent.health_port,
        "health_config_errors": agent.health_config_errors,
        "sensor_catalog": agent.sensor_catalog,
        "health_loop_board_id": agent.health_loop_board_id,
        "health_loop_state": agent.health_loop_state,
        "health_loop_park_reason": agent.health_loop_park_reason,
        "health_loop_parked_since": agent.health_loop_parked_since,
    }


async def test_ws_and_http_heartbeat_paths_produce_identical_state(
    db_session: AsyncSession, test_agent: Agent
):
    """Invoking the WS handler with a payload dict must produce the same
    agent state as invoking the HTTP service method with a HeartbeatBody.
    Captures the parity contract for the deprecation window."""
    service = AgentService(db_session)

    http_body = HeartbeatBody(**CANONICAL_HEARTBEAT)
    http_updated = await service.heartbeat(test_agent.id, http_body)
    http_state = _snapshot(http_updated)

    # Reset fields to NULL so the next path writes them fresh.
    for key in http_state:
        setattr(http_updated, key, None)
    await db_session.flush()
    await db_session.refresh(http_updated)

    ws_updated = await service.handle_ws_heartbeat(
        test_agent.id, CANONICAL_HEARTBEAT
    )
    ws_state = _snapshot(ws_updated)

    # last_seen_at moves on every call; the rest must match exactly.
    assert ws_state == http_state


async def test_ws_heartbeat_accepts_empty_payload(
    db_session: AsyncSession, test_agent: Agent
):
    service = AgentService(db_session)
    updated = await service.handle_ws_heartbeat(test_agent.id, {})
    assert updated.last_seen_at is not None
    # No health fields should be touched by an empty payload.
    assert updated.health_status is None


async def test_ws_heartbeat_rejects_unknown_agent_id(db_session: AsyncSession):
    import uuid

    from app.exceptions import ResourceNotFoundError

    service = AgentService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.handle_ws_heartbeat(uuid.uuid4(), {})


async def test_ws_heartbeat_clears_current_card_on_idle(
    db_session: AsyncSession, test_agent: Agent
):
    service = AgentService(db_session)
    await service.handle_ws_heartbeat(
        test_agent.id, {"status": "working", "current_card_id": "card-x"}
    )
    updated = await service.handle_ws_heartbeat(
        test_agent.id, {"status": "idle"}
    )
    assert updated.health_status == "idle"
    assert updated.health_current_card_id is None


async def test_ws_heartbeat_publishes_event(
    db_session: AsyncSession, test_agent: Agent, test_workspace
):
    """Each WS heartbeat publishes agent.heartbeat_received so frontend
    consumers can live-update the last-seen indicator."""
    from app.core.event_bus import event_bus

    received: list[tuple[str, dict[str, Any]]] = []

    async def _capture(event):
        received.append((event.event_type, event.payload))

    unsub = event_bus.subscribe(
        callback=_capture,
        workspace_id=test_workspace.id,
        event_pattern="agent.heartbeat_received",
    )
    try:
        await AgentService(db_session).handle_ws_heartbeat(
            test_agent.id, {"status": "idle"}, workspace_id=test_workspace.id
        )
        assert any(
            evt == "agent.heartbeat_received"
            and payload.get("agent_id") == str(test_agent.id)
            for evt, payload in received
        )
    finally:
        unsub()


def test_canonical_payload_covers_every_heartbeat_field():
    """Guard: the canonical payload must carry every field HeartbeatBody
    knows about, so the parity test exercises the whole surface."""
    declared = set(HeartbeatBody.model_fields.keys())
    sent = set(CANONICAL_HEARTBEAT.keys())
    missing = declared - sent
    assert not missing, f"canonical heartbeat missing fields: {missing}"
