# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import timedelta

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import COST_THRESHOLD_CROSSED
from app.exceptions import ResourceNotFoundError
from app.models.agents.execution import AgentExecution
from app.repositories.alerts.alert_threshold import AlertThresholdRepository
from app.schemas.alerts.alert_threshold import AlertThresholdCreate, AlertThresholdUpdate
from app.utils import utcnow

COST_METRICS = {"cost_usd_7d", "cost_usd_30d"}


class AlertThresholdService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = AlertThresholdRepository(db)

    async def create(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, data: AlertThresholdCreate
    ):
        return await self.repo.create(
            workspace_id=workspace_id,
            created_by_id=user_id,
            name=data.name,
            metric=data.metric,
            operator=data.operator,
            value=data.value,
            board_id=data.board_id,
        )

    async def list_thresholds(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID | None = None
    ):
        return await self.repo.list_by_workspace(workspace_id, board_id)

    async def get(self, threshold_id: uuid.UUID, workspace_id: uuid.UUID):
        threshold = await self.repo.get_by_id(threshold_id)
        if not threshold or threshold.workspace_id != workspace_id:
            raise ResourceNotFoundError("Alert threshold not found")
        return threshold

    async def update(
        self, threshold_id: uuid.UUID, workspace_id: uuid.UUID, data: AlertThresholdUpdate
    ):
        threshold = await self.get(threshold_id, workspace_id)
        update_data = data.model_dump(exclude_unset=True)
        return await self.repo.update(threshold, **update_data)

    async def delete(self, threshold_id: uuid.UUID, workspace_id: uuid.UUID):
        threshold = await self.get(threshold_id, workspace_id)
        await self.repo.delete(threshold)

    async def evaluate_for_board(self, board_id: uuid.UUID, metrics: dict) -> list[dict]:
        thresholds = await self.repo.list_active_by_board(board_id)
        triggered = []

        for threshold in thresholds:
            current_value = metrics.get(threshold.metric.value)
            if current_value is None:
                continue

            if _check_threshold(threshold.operator.value, current_value, threshold.value):
                triggered.append({
                    "threshold_id": threshold.id,
                    "name": threshold.name,
                    "metric": threshold.metric.value,
                    "operator": threshold.operator.value,
                    "target_value": threshold.value,
                    "current_value": current_value,
                })

        return triggered

    async def evaluate_cost_thresholds(self, workspace_id: uuid.UUID) -> list[dict]:
        """Evaluate all active cost thresholds for a workspace and emit events for triggered ones."""
        thresholds = await self.repo.list_active_cost_thresholds(workspace_id)
        if not thresholds:
            return []

        cost_7d, cost_30d = await self._get_workspace_cost(workspace_id)
        cost_values = {
            "cost_usd_7d": cost_7d,
            "cost_usd_30d": cost_30d,
        }

        triggered = []
        for threshold in thresholds:
            current_value = cost_values.get(threshold.metric.value)
            if current_value is None:
                continue

            if _check_threshold(threshold.operator.value, current_value, threshold.value):
                result = {
                    "threshold_id": threshold.id,
                    "name": threshold.name,
                    "metric": threshold.metric.value,
                    "operator": threshold.operator.value,
                    "target_value": threshold.value,
                    "current_value": current_value,
                }
                triggered.append(result)

                await event_bus.publish(
                    event_type=COST_THRESHOLD_CROSSED,
                    payload={
                        "threshold_id": str(threshold.id),
                        "metric": threshold.metric.value,
                        "operator": threshold.operator.value,
                        "target_value": threshold.value,
                        "current_value": current_value,
                        "workspace_id": str(workspace_id),
                        "board_id": None,
                    },
                    workspace_id=workspace_id,
                )

        return triggered

    async def _get_workspace_cost(self, workspace_id: uuid.UUID) -> tuple[float, float]:
        """Return (cost_7d, cost_30d) for all executions in the workspace."""
        now = utcnow()
        since_7d = now - timedelta(days=7)
        since_30d = now - timedelta(days=30)

        stmt = select(
            func.coalesce(
                func.sum(
                    case(
                        (AgentExecution.started_at >= since_7d, AgentExecution.cost_usd),
                        else_=0.0,
                    )
                ),
                0.0,
            ).label("cost_7d"),
            func.coalesce(func.sum(AgentExecution.cost_usd), 0.0).label("cost_30d"),
        ).where(
            AgentExecution.workspace_id == workspace_id,
            AgentExecution.started_at >= since_30d,
        )

        result = await self.db.execute(stmt)
        row = result.one()
        return round(float(row.cost_7d), 4), round(float(row.cost_30d), 4)


def _check_threshold(operator: str, current: float, target: float) -> bool:
    operator_fns = {
        "gt": lambda c, t: c > t,
        "gte": lambda c, t: c >= t,
        "lt": lambda c, t: c < t,
        "lte": lambda c, t: c <= t,
        "eq": lambda c, t: c == t,
    }
    fn = operator_fns.get(operator)
    return fn(current, target) if fn else False
