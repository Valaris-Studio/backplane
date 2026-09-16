# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select

from app.models.alerts.alert_threshold import AlertThreshold
from app.repositories.base import BaseRepository


class AlertThresholdRepository(BaseRepository[AlertThreshold]):
    model = AlertThreshold

    async def list_by_workspace(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID | None = None
    ) -> list[AlertThreshold]:
        stmt = select(AlertThreshold).where(
            AlertThreshold.workspace_id == workspace_id
        )
        if board_id:
            stmt = stmt.where(AlertThreshold.board_id == board_id)
        stmt = stmt.order_by(AlertThreshold.created_at.desc())
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def list_active_by_board(
        self, board_id: uuid.UUID
    ) -> list[AlertThreshold]:
        result = await self.db.execute(
            select(AlertThreshold)
            .where(AlertThreshold.board_id == board_id, AlertThreshold.is_active.is_(True))
            .order_by(AlertThreshold.created_at.desc())
        )
        return list(result.scalars().all())

    async def list_active_cost_thresholds(
        self, workspace_id: uuid.UUID
    ) -> list[AlertThreshold]:
        from app.models.alerts.alert_threshold import AlertMetric
        result = await self.db.execute(
            select(AlertThreshold)
            .where(
                AlertThreshold.workspace_id == workspace_id,
                AlertThreshold.is_active.is_(True),
                AlertThreshold.metric.in_([AlertMetric.cost_usd_7d, AlertMetric.cost_usd_30d]),
            )
            .order_by(AlertThreshold.created_at.desc())
        )
        return list(result.scalars().all())
