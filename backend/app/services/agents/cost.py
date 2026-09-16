# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace-level cost circuit breaker (card e244867f).

`workspace_cost_in_window` is a stateless rolling-window sum over
AgentExecution.cost_usd; `evaluate_circuit_breaker` decides whether the
configured threshold has been crossed and emits cost.threshold_crossed
exactly once per `_DEDUPE_WINDOW_SECONDS` per workspace (in-process).

Dedupe is in-process by design: this is the smallest cohesive piece that
prevents per-tick event storms while the breaker is firing. The resume
endpoint clears the dedupe so the next signal can re-fire.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Mapping

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import COST_THRESHOLD_CROSSED
from app.models.agents.execution import AgentExecution
from app.utils import utcnow

logger = logging.getLogger(__name__)


# Suppress repeat emissions while spend stays over threshold. Operators
# clear via /cost-breaker/resume.
_DEDUPE_WINDOW_SECONDS = 60

# Module-level so dedupe persists across requests; lifetime is the
# process. Cleared by reset_breaker_dedupe (resume endpoint + tests).
_last_emitted: dict[uuid.UUID, datetime] = {}


@dataclass
class BreakerResult:
    triggered: bool
    action: str | None = None
    current_usd: float = 0.0
    threshold_usd: float | None = None


async def workspace_cost_in_window(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    window_seconds: int = 900,
) -> float:
    """Sum AgentExecution.cost_usd for `workspace_id` within the trailing window."""
    since = utcnow() - timedelta(seconds=window_seconds)
    stmt = select(func.coalesce(func.sum(AgentExecution.cost_usd), 0.0)).where(
        AgentExecution.workspace_id == workspace_id,
        AgentExecution.started_at >= since,
    )
    result = await db.execute(stmt)
    return float(result.scalar_one())


def _normalize_breaker_config(
    breaker: Mapping | None,
) -> tuple[bool, float, str] | None:
    if not breaker:
        return None
    enabled = bool(breaker.get("enabled", False))
    if not enabled:
        return None
    try:
        threshold = float(breaker.get("threshold_usd_per_15min", 0.0))
    except (TypeError, ValueError):
        return None
    if threshold <= 0:
        return None
    action = str(breaker.get("action") or "pause")
    return enabled, threshold, action


async def evaluate_circuit_breaker(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    breaker_config: Mapping | None,
    window_seconds: int = 900,
) -> BreakerResult:
    """Compute current spend, compare against threshold, emit event on transition."""
    parsed = _normalize_breaker_config(breaker_config)
    if parsed is None:
        return BreakerResult(triggered=False)

    _enabled, threshold, action = parsed

    current = await workspace_cost_in_window(db, workspace_id, window_seconds)
    if current <= threshold:
        return BreakerResult(
            triggered=False,
            current_usd=current,
            threshold_usd=threshold,
        )

    now = utcnow()
    last = _last_emitted.get(workspace_id)
    if last is None or (now - last).total_seconds() >= _DEDUPE_WINDOW_SECONDS:
        _last_emitted[workspace_id] = now
        try:
            await event_bus.publish(
                event_type=COST_THRESHOLD_CROSSED,
                payload={
                    "workspace_id": str(workspace_id),
                    "current_usd": current,
                    "threshold_usd": threshold,
                    "action": action,
                    "window_seconds": window_seconds,
                },
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish COST_THRESHOLD_CROSSED")

    return BreakerResult(
        triggered=True,
        action=action,
        current_usd=current,
        threshold_usd=threshold,
    )


def reset_breaker_dedupe(workspace_id: uuid.UUID) -> None:
    """Clear the in-process dedupe key for a workspace (resume CTA + tests)."""
    _last_emitted.pop(workspace_id, None)
