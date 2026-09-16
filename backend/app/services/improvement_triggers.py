# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""
Service to detect platform improvement opportunities from execution logs,
board health data, and error patterns.
"""
import uuid
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.utils import utcnow

from app.models.agents.execution import AgentExecution, ExecutionStatus


class ImprovementTrigger:
    """A detected improvement opportunity."""
    def __init__(self, trigger_type: str, severity: str, description: str, context: dict):
        self.trigger_type = trigger_type
        self.severity = severity  # low, medium, high
        self.description = description
        self.context = context


class ImprovementTriggerService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def detect_triggers(self, workspace_id: uuid.UUID) -> list[ImprovementTrigger]:
        """Scan for improvement opportunities across all signals."""
        triggers = []
        triggers.extend(await self._detect_repeated_failures(workspace_id))
        triggers.extend(await self._detect_high_error_rate(workspace_id))
        triggers.extend(await self._detect_slow_executions(workspace_id))
        return triggers

    async def _detect_repeated_failures(
        self, workspace_id: uuid.UUID
    ) -> list[ImprovementTrigger]:
        """Detect tools/actions that fail repeatedly (3+ times in 24h)."""
        since = utcnow() - timedelta(hours=24)
        stmt = (
            select(AgentExecution.action, func.count())
            .where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.status == ExecutionStatus.failed,
                AgentExecution.started_at >= since,
            )
            .group_by(AgentExecution.action)
            .having(func.count() >= 3)
        )
        result = await self.db.execute(stmt)
        triggers = []
        for action, count in result.all():
            triggers.append(ImprovementTrigger(
                trigger_type="repeated_failure",
                severity="high",
                description=f"Action '{action}' failed {count} times in the last 24h",
                context={"action": action, "failure_count": count},
            ))
        return triggers

    async def _detect_high_error_rate(
        self, workspace_id: uuid.UUID
    ) -> list[ImprovementTrigger]:
        """Detect agents with > 50% failure rate in last 7 days."""
        since = utcnow() - timedelta(days=7)
        stmt = (
            select(
                AgentExecution.agent_id,
                func.count().filter(AgentExecution.status == ExecutionStatus.failed),
                func.count(),
            )
            .where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.started_at >= since,
            )
            .group_by(AgentExecution.agent_id)
            .having(func.count() >= 5)  # Only flag if enough data
        )
        result = await self.db.execute(stmt)
        triggers = []
        for agent_id, failed, total in result.all():
            rate = failed / total
            if rate > 0.5:
                triggers.append(ImprovementTrigger(
                    trigger_type="high_error_rate",
                    severity="medium",
                    description=f"Agent {agent_id} has {rate:.0%} failure rate ({failed}/{total}) in last 7 days",
                    context={"agent_id": str(agent_id), "failure_rate": rate, "failed": failed, "total": total},
                ))
        return triggers

    async def _detect_slow_executions(
        self, workspace_id: uuid.UUID
    ) -> list[ImprovementTrigger]:
        """Detect actions with average duration > 120 seconds."""
        since = utcnow() - timedelta(days=7)
        stmt = (
            select(
                AgentExecution.action,
                func.avg(AgentExecution.duration_seconds),
                func.count(),
            )
            .where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.status == ExecutionStatus.completed,
                AgentExecution.duration_seconds.isnot(None),
                AgentExecution.started_at >= since,
            )
            .group_by(AgentExecution.action)
            .having(func.count() >= 3)
        )
        result = await self.db.execute(stmt)
        triggers = []
        for action, avg_duration, count in result.all():
            if avg_duration and avg_duration > 120:
                triggers.append(ImprovementTrigger(
                    trigger_type="slow_execution",
                    severity="low",
                    description=f"Action '{action}' averages {avg_duration:.0f}s over {count} executions",
                    context={"action": action, "avg_duration": float(avg_duration), "count": count},
                ))
        return triggers

    async def count_improvement_prs_today(self, workspace_id: uuid.UUID) -> int:
        """Count improvement PRs created today (for rate limiting)."""
        today_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        stmt = (
            select(func.count())
            .select_from(AgentExecution)
            .where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.action == "self_improvement",
                AgentExecution.started_at >= today_start,
            )
        )
        result = await self.db.execute(stmt)
        return result.scalar_one()

    async def can_run_improvement(self, workspace_id: uuid.UUID, max_per_day: int = 3) -> bool:
        """Check if we're under the daily rate limit for improvements."""
        count = await self.count_improvement_prs_today(workspace_id)
        return count < max_per_day
