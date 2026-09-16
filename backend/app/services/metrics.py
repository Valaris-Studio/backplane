# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from collections import defaultdict
from datetime import datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from app.repositories.agents.execution import ExecutionRepository
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.utils import utcnow
from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.schemas.agents.analytics import DailyMetric, ExecutionAnalytics, RoleCount
from app.schemas.metrics import (
    AgentCostMetric,
    AgentMetric,
    AgentMetricsRead,
    CardCostMetric,
    CardCostRead,
    CostRead,
    QualityRead,
    VelocityRead,
)
from app.services.agents.liveness import compute_liveness


def _compute_liveness_for_metrics(last_seen_at: datetime | None) -> str:
    # Wrapper so the metrics path is decoupled from any future arg shifts in
    # compute_liveness; both paths must agree on the threshold definition.
    return compute_liveness(last_seen_at)


# How long an in-flight execution counts as evidence of life. Loop runners
# heartbeat only BETWEEN iterations, so a long iteration silences the
# heartbeat well past the offline threshold while the runner is genuinely
# working — but an in-flight row older than any plausible runtime is a wedge
# left by a dead process. Iterations are bounded by iteration_timeout
# (default 1h); 2h covers every sane execution without letting a wedge read
# alive for more than one window.
INFLIGHT_EVIDENCE_MAX_AGE = timedelta(hours=2)


def _liveness_with_inflight_promotion(
    last_seen_at: datetime | None, inflight_started_at: datetime | None
) -> str:
    liveness = _compute_liveness_for_metrics(last_seen_at)
    if (
        inflight_started_at is not None
        and utcnow() - inflight_started_at < INFLIGHT_EVIDENCE_MAX_AGE
    ):
        return "alive"
    return liveness


class MetricsService:
    def __init__(self, db: AsyncSession):
        self.db = db

    def _execution_repo(self) -> "ExecutionRepository":
        from app.repositories.agents.execution import ExecutionRepository

        return ExecutionRepository(self.db)

    async def get_agent_metrics(
        self,
        workspace_id: uuid.UUID,
        *,
        include_inactive: bool = False,
    ) -> AgentMetricsRead:
        # Resolve workspace slug for allowed_workspaces filter
        from app.models.workspace import Workspace

        ws_result = await self.db.execute(
            select(Workspace.slug).where(Workspace.id == workspace_id)
        )
        ws_slug = ws_result.scalar_one_or_none()

        # Left join: agents appear even with zero executions
        stmt = (
            select(
                Agent.id.label("agent_id"),
                Agent.name,
                Agent.agent_type,
                Agent.is_active,
                Agent.is_paused,
                Agent.last_seen_at,
                Agent.health_status,
                Agent.health_version,
                Agent.health_uptime_seconds,
                Agent.health_cards_processed,
                Agent.health_cards_failed,
                Agent.health_current_card_id,
                Agent.health_current_board_id,
                Agent.health_last_error,
                Agent.health_last_error_at,
                Agent.health_config_errors,
                func.count(AgentExecution.id).label("total"),
                func.count(AgentExecution.id)
                .filter(AgentExecution.status == ExecutionStatus.completed)
                .label("completed"),
                func.count(AgentExecution.id)
                .filter(AgentExecution.status == ExecutionStatus.failed)
                .label("failed"),
                func.avg(AgentExecution.duration_seconds).label("avg_dur"),
                func.coalesce(func.sum(AgentExecution.tokens_used), 0).label(
                    "total_tokens"
                ),
                func.coalesce(func.sum(AgentExecution.cost_usd), 0.0).label(
                    "total_cost"
                ),
            )
            .outerjoin(
                AgentExecution,
                (AgentExecution.agent_id == Agent.id)
                & (AgentExecution.workspace_id == workspace_id),
            )
            .group_by(Agent.id)
        )
        if not include_inactive:
            stmt = stmt.where(Agent.is_active.is_(True))
        # Filter to agents allowed in this workspace.
        # allowed_workspaces is a JSON array like ["slug1", "slug2"].
        # Use text LIKE for portability across PostgreSQL and SQLite (tests).
        if ws_slug:
            from sqlalchemy import String as SAString

            stmt = stmt.where(
                func.coalesce(Agent.allowed_workspaces.cast(SAString), "").contains(
                    ws_slug
                )
            )
        result = await self.db.execute(stmt)
        rows = result.all()

        # Agents with an in-flight execution RIGHT NOW (started/running, no
        # completed_at) in this workspace. This is the authoritative "working"
        # signal — independent of heartbeat freshness, which lags during long
        # LLM stages. Unbounded query (see list_inflight_by_workspace) so an
        # active row is never hidden behind a page of completed rows.
        inflight = await self._execution_repo().list_inflight_by_workspace(workspace_id)
        working_agent_ids = {e.agent_id for e in inflight}
        # Freshest in-flight start per agent — the liveness evidence for the
        # age-aware promotion (a wedged row from days ago must not count).
        inflight_started_at: dict[uuid.UUID, datetime] = {}
        for e in inflight:
            if e.started_at is not None and (
                e.agent_id not in inflight_started_at
                or e.started_at > inflight_started_at[e.agent_id]
            ):
                inflight_started_at[e.agent_id] = e.started_at

        agents = [
            AgentMetric(
                agent_id=str(row.agent_id),
                name=row.name,
                agent_type=row.agent_type.value
                if hasattr(row.agent_type, "value")
                else str(row.agent_type),
                is_active=row.is_active,
                is_paused=bool(row.is_paused),
                total_executions=row.total,
                completed_executions=row.completed,
                failed_executions=row.failed,
                avg_duration_seconds=round(row.avg_dur, 2)
                if row.avg_dur is not None
                else None,
                total_tokens_used=row.total_tokens,
                total_cost_usd=round(row.total_cost, 4),
                last_seen_at=row.last_seen_at.isoformat() if row.last_seen_at else None,
                liveness=_liveness_with_inflight_promotion(
                    row.last_seen_at, inflight_started_at.get(row.agent_id)
                ),
                working=row.agent_id in working_agent_ids,
                health_status=row.health_status,
                health_version=row.health_version,
                health_uptime_seconds=row.health_uptime_seconds,
                health_cards_processed=row.health_cards_processed,
                health_cards_failed=row.health_cards_failed,
                health_current_card_id=row.health_current_card_id,
                health_current_board_id=row.health_current_board_id,
                health_last_error=row.health_last_error,
                health_last_error_at=row.health_last_error_at.isoformat()
                if row.health_last_error_at
                else None,
                health_config_errors=row.health_config_errors,
            )
            for row in rows
        ]
        return AgentMetricsRead(agents=agents)

    async def get_velocity(self, workspace_id: uuid.UUID) -> VelocityRead:
        now = utcnow()

        # Find last columns for all boards in the workspace
        last_column_ids = await self._get_last_column_ids(workspace_id)
        if not last_column_ids:
            return VelocityRead(
                cards_completed_7d=0, cards_completed_30d=0, cards_completed_90d=0
            )

        last_col_strings = {str(cid) for cid in last_column_ids}

        cards_7d = await self._count_completed(
            workspace_id, now - timedelta(days=7), last_col_strings
        )
        cards_30d = await self._count_completed(
            workspace_id, now - timedelta(days=30), last_col_strings
        )
        cards_90d = await self._count_completed(
            workspace_id, now - timedelta(days=90), last_col_strings
        )

        return VelocityRead(
            cards_completed_7d=cards_7d,
            cards_completed_30d=cards_30d,
            cards_completed_90d=cards_90d,
        )

    async def get_quality(self, workspace_id: uuid.UUID) -> QualityRead:
        reversion_rate = await self._compute_reversion_rate(workspace_id)
        efficiency = await self._compute_agent_efficiency(workspace_id)
        return QualityRead(
            reversion_rate=reversion_rate, agent_efficiency_score=efficiency
        )

    async def get_cost(self, workspace_id: uuid.UUID) -> CostRead:
        now = utcnow()
        since_7d = now - timedelta(days=7)
        since_30d = now - timedelta(days=30)

        stmt = (
            select(
                Agent.name,
                Agent.agent_type,
                func.coalesce(
                    func.sum(
                        case(
                            (
                                AgentExecution.started_at >= since_7d,
                                AgentExecution.tokens_used,
                            )
                        )
                    ),
                    0,
                ).label("tokens_7d"),
                func.coalesce(
                    func.sum(
                        case(
                            (
                                AgentExecution.started_at >= since_30d,
                                AgentExecution.tokens_used,
                            )
                        )
                    ),
                    0,
                ).label("tokens_30d"),
                func.count()
                .filter(AgentExecution.started_at >= since_7d)
                .label("exec_7d"),
                func.count()
                .filter(AgentExecution.started_at >= since_30d)
                .label("exec_30d"),
            )
            .join(Agent, AgentExecution.agent_id == Agent.id)
            .where(
                AgentExecution.workspace_id == workspace_id,
                AgentExecution.started_at >= since_30d,
            )
            .group_by(Agent.id, Agent.name, Agent.agent_type)
        )
        result = await self.db.execute(stmt)
        rows = result.all()

        agents = [
            AgentCostMetric(
                name=row.name,
                agent_type=row.agent_type.value
                if hasattr(row.agent_type, "value")
                else str(row.agent_type),
                tokens_used_7d=row.tokens_7d,
                tokens_used_30d=row.tokens_30d,
                executions_7d=row.exec_7d,
                executions_30d=row.exec_30d,
            )
            for row in rows
        ]
        return CostRead(agents=agents)

    async def get_card_costs(self, workspace_id: uuid.UUID) -> CardCostRead:
        stmt = select(
            AgentExecution.cards_affected,
            AgentExecution.cost_usd,
            AgentExecution.tokens_used,
        ).where(
            AgentExecution.workspace_id == workspace_id,
            AgentExecution.cards_affected.isnot(None),
        )
        result = await self.db.execute(stmt)
        rows = result.all()

        card_costs: dict[str, dict] = {}
        for cards_affected, cost_usd, tokens_used in rows:
            if not cards_affected:
                continue
            per_card_cost = (cost_usd or 0.0) / len(cards_affected)
            per_card_tokens = (tokens_used or 0) // max(len(cards_affected), 1)
            for card_id in cards_affected:
                if card_id not in card_costs:
                    card_costs[card_id] = {
                        "total_cost_usd": 0.0,
                        "total_tokens": 0,
                        "execution_count": 0,
                    }
                card_costs[card_id]["total_cost_usd"] += per_card_cost
                card_costs[card_id]["total_tokens"] += per_card_tokens
                card_costs[card_id]["execution_count"] += 1

        cards = [
            CardCostMetric(
                card_id=card_id,
                total_cost_usd=round(data["total_cost_usd"], 4),
                total_tokens=data["total_tokens"],
                execution_count=data["execution_count"],
            )
            for card_id, data in sorted(
                card_costs.items(), key=lambda x: x[1]["total_cost_usd"], reverse=True
            )
        ]
        return CardCostRead(cards=cards)

    async def get_execution_analytics(
        self,
        workspace_id: uuid.UUID,
        days: int = 30,
        agent_id: uuid.UUID | None = None,
    ) -> ExecutionAnalytics:
        since = utcnow() - timedelta(days=days)

        filters = [
            AgentExecution.workspace_id == workspace_id,
            AgentExecution.started_at >= since,
        ]
        if agent_id:
            filters.append(AgentExecution.agent_id == agent_id)

        stmt = select(AgentExecution).where(*filters)
        result = await self.db.execute(stmt)
        executions = list(result.scalars().all())

        if not executions:
            return ExecutionAnalytics(
                daily_metrics=[],
                total_executions=0,
                total_completed=0,
                total_failed=0,
                total_cost_usd=0.0,
                success_rate=0.0,
                rework_rate=0.0,
                avg_duration_seconds=0.0,
                avg_cost_per_card=0.0,
            )

        total = len(executions)
        completed = sum(1 for e in executions if e.status == ExecutionStatus.completed)
        failed = sum(1 for e in executions if e.status == ExecutionStatus.failed)
        total_cost = sum(e.cost_usd or 0.0 for e in executions)
        rework_count = sum(
            1 for e in executions if "rework" in (e.action or "").lower()
        )

        durations = [
            e.duration_seconds for e in executions if e.duration_seconds is not None
        ]
        avg_duration = sum(durations) / len(durations) if durations else 0.0

        unique_cards: set[str] = set()
        for e in executions:
            if e.cards_affected:
                unique_cards.update(e.cards_affected)
        avg_cost_per_card = total_cost / len(unique_cards) if unique_cards else 0.0

        terminal = completed + failed
        success_rate = completed / terminal if terminal > 0 else 0.0

        # Group by date for daily metrics
        daily: dict[str, dict] = defaultdict(
            lambda: {
                "cards_completed": 0,
                "cost_usd": 0.0,
                "executions": 0,
                "failures": 0,
            }
        )
        for e in executions:
            date_key = e.started_at.strftime("%Y-%m-%d")
            daily[date_key]["executions"] += 1
            daily[date_key]["cost_usd"] += e.cost_usd or 0.0
            if e.status == ExecutionStatus.completed:
                daily[date_key]["cards_completed"] += 1
            if e.status == ExecutionStatus.failed:
                daily[date_key]["failures"] += 1

        daily_metrics = sorted(
            [DailyMetric(date=date, **vals) for date, vals in daily.items()],
            key=lambda m: m.date,
        )

        # Group by role over the FULL window (not a paginated slice) so the
        # frontend's role-distribution chart counts every execution. The runner
        # always threads a pipeline role for card work, so a NULL role marks a
        # NON-pipeline execution (standup, mcp_session, ad-hoc). Lumping all of
        # those into one opaque "unknown" made the chart read as mostly
        # "unassigned"; instead label each by its action, prefixed `action:` so
        # the frontend can distinguish an action-derived label from a real
        # pipeline role and translate each accordingly. Falls back to
        # `action:unknown` only when the action itself is somehow empty.
        role_counts: dict[str, int] = defaultdict(int)
        for e in executions:
            if e.role:
                bucket = e.role
            else:
                bucket = f"action:{e.action or 'unknown'}"
            role_counts[bucket] += 1
        role_distribution = sorted(
            (RoleCount(role=role, count=count) for role, count in role_counts.items()),
            key=lambda r: r.count,
            reverse=True,
        )

        return ExecutionAnalytics(
            daily_metrics=daily_metrics,
            total_executions=total,
            total_completed=completed,
            total_failed=failed,
            total_cost_usd=round(total_cost, 4),
            success_rate=round(success_rate, 4),
            rework_rate=round(rework_count / total, 4) if total > 0 else 0.0,
            avg_duration_seconds=round(avg_duration, 2),
            avg_cost_per_card=round(avg_cost_per_card, 4),
            role_distribution=role_distribution,
        )

    # -- Private helpers --

    async def _get_last_column_ids(self, workspace_id: uuid.UUID) -> list[uuid.UUID]:
        """Get the last column (highest position) for each board in the workspace."""
        stmt = select(Board.id).where(Board.workspace_id == workspace_id)
        result = await self.db.execute(stmt)
        board_ids = [row[0] for row in result.all()]

        last_col_ids: list[uuid.UUID] = []
        for board_id in board_ids:
            col_stmt = (
                select(Column.id)
                .where(Column.board_id == board_id)
                .order_by(Column.position.desc())
                .limit(1)
            )
            col_result = await self.db.execute(col_stmt)
            col_id = col_result.scalar_one_or_none()
            if col_id:
                last_col_ids.append(col_id)

        return last_col_ids

    async def _count_completed(
        self, workspace_id: uuid.UUID, since: datetime, last_col_strings: set[str]
    ) -> int:
        stmt = select(Activity).where(
            Activity.workspace_id == workspace_id,
            Activity.action == ActivityAction.moved,
            Activity.entity_type == ActivityEntityType.card,
            Activity.created_at >= since,
        )
        result = await self.db.execute(stmt)
        activities = result.scalars().all()

        count = 0
        for activity in activities:
            if not activity.changes:
                continue
            col_change = activity.changes.get("column_id", {})
            if col_change.get("new") in last_col_strings:
                count += 1
        return count

    async def _compute_reversion_rate(self, workspace_id: uuid.UUID) -> float | None:
        """Ratio of backward moves to total moves in last 30 days across all boards."""
        since = utcnow() - timedelta(days=30)

        # Build column position map for all boards in workspace
        boards_stmt = select(Board.id).where(Board.workspace_id == workspace_id)
        boards_result = await self.db.execute(boards_stmt)
        board_ids = [row[0] for row in boards_result.all()]

        if not board_ids:
            return None

        # Map column_id -> position across all boards
        col_stmt = select(Column.id, Column.position).where(
            Column.board_id.in_(board_ids)
        )
        col_result = await self.db.execute(col_stmt)
        col_positions: dict[str, float] = {
            str(row[0]): row[1] for row in col_result.all()
        }

        if not col_positions:
            return None

        moves_stmt = select(Activity).where(
            Activity.workspace_id == workspace_id,
            Activity.action == ActivityAction.moved,
            Activity.entity_type == ActivityEntityType.card,
            Activity.created_at >= since,
        )
        result = await self.db.execute(moves_stmt)
        moves = list(result.scalars().all())

        if not moves:
            return None

        backward_count = 0
        for move in moves:
            if not move.changes:
                continue
            col_change = move.changes.get("column_id", {})
            from_col_id = col_change.get("old")
            to_col_id = col_change.get("new")
            if not from_col_id or not to_col_id:
                continue
            from_pos = col_positions.get(from_col_id)
            to_pos = col_positions.get(to_col_id)
            if from_pos is not None and to_pos is not None and to_pos < from_pos:
                backward_count += 1

        return round(backward_count / len(moves), 3)

    async def _compute_agent_efficiency(self, workspace_id: uuid.UUID) -> float | None:
        """Ratio of completed executions to total executions for the workspace."""
        stmt = select(
            func.count().filter(AgentExecution.status == ExecutionStatus.completed),
            func.count(),
        ).where(AgentExecution.workspace_id == workspace_id)
        result = await self.db.execute(stmt)
        row = result.one()
        completed, total = row[0], row[1]
        if total == 0:
            return None
        return round(completed / total, 3)
