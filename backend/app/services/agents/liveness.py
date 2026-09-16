# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Runner liveness derivation + transition detection.

Card 40424fb3. Liveness is computed from `last_seen_at` rather than stored
as a column — the heartbeat timestamp is already authoritative and the
derivation avoids a schema migration.

Tri-state model:
    alive    — heartbeat within ALIVE_THRESHOLD_SECONDS
    stale    — silent past alive threshold but inside the offline window
    offline  — silent past OFFLINE_THRESHOLD_SECONDS (process likely dead)
    unknown  — never sent a heartbeat

The scan task is a *backup* signal: the primary liveness signal is the WS
heartbeat itself. Cloud Run rolling deploys mean the scan loop may not run
on every replica; transitions are deduped per-process via LivenessTracker so
a moment of duplication on rollover is harmless.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import select

from app.core.events import AGENT_STATUS_CHANGED
from app.models.agents.agent import Agent
from app.utils import utcnow

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from app.core.event_bus import EventBus

logger = logging.getLogger(__name__)

ALIVE_THRESHOLD_SECONDS = 90
OFFLINE_THRESHOLD_SECONDS = 600


def compute_liveness(
    last_seen_at: datetime | None,
    alive_threshold: int = ALIVE_THRESHOLD_SECONDS,
    offline_threshold: int = OFFLINE_THRESHOLD_SECONDS,
) -> str:
    if last_seen_at is None:
        return "unknown"
    # last_seen_at is stored naive UTC; utcnow() matches that convention.
    elapsed = (utcnow() - last_seen_at).total_seconds()
    if elapsed <= alive_threshold:
        return "alive"
    if elapsed <= offline_threshold:
        return "stale"
    return "offline"


class LivenessTracker:
    """Per-process cache of last-published liveness, used to dedupe events.

    A single instance is held by the app lifespan task. Each scan compares
    the freshly-derived liveness against the cached value and only publishes
    `agent.status_changed` on a true transition.
    """

    def __init__(self) -> None:
        self._last: dict[uuid.UUID, str] = {}

    def seed(self, agent_id: uuid.UUID, liveness: str) -> None:
        self._last[agent_id] = liveness

    async def scan_and_publish(
        self, db: AsyncSession, event_bus: EventBus
    ) -> int:
        """Scan active agents, publish on transitions, return count of transitions."""
        result = await db.execute(
            select(Agent).where(Agent.is_active.is_(True))
        )
        agents = list(result.scalars().all())

        transitions = 0
        for agent in agents:
            current = compute_liveness(agent.last_seen_at)
            previous = self._last.get(agent.id)
            if previous == current:
                continue
            self._last[agent.id] = current
            if previous is None:
                # First sighting — record state but don't publish (no transition).
                continue

            workspace_id = await _resolve_workspace_id(db, agent)
            if workspace_id is None:
                # Agent has no resolvable workspace — can't fan out. Still
                # cached to avoid replaying once the allowlist is set.
                continue

            try:
                await event_bus.publish(
                    event_type=AGENT_STATUS_CHANGED,
                    payload={
                        "agent_id": str(agent.id),
                        "liveness": current,
                        "previous_liveness": previous,
                    },
                    workspace_id=workspace_id,
                )
                transitions += 1
            except Exception:
                logger.exception(
                    "Failed to publish agent.status_changed for %s", agent.id
                )

        return transitions


async def _resolve_workspace_id(db: AsyncSession, agent: Agent) -> uuid.UUID | None:
    """Resolve an agent's primary workspace UUID from its allowlist.

    Mirrors AgentService._resolve_workspace_id but lives here so the scan
    loop is not coupled to the service-layer DI graph.
    """
    workspaces = agent.allowed_workspaces
    if not workspaces or not isinstance(workspaces, list) or len(workspaces) == 0:
        return None
    entry = str(workspaces[0])
    try:
        return uuid.UUID(entry)
    except (ValueError, TypeError):
        pass
    from app.models.workspace import Workspace

    result = await db.execute(select(Workspace.id).where(Workspace.slug == entry))
    return result.scalar_one_or_none()
