# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.approvals.approval import ApprovalRequest, ApprovalStatus
from app.repositories.base import BaseRepository


class ApprovalRepository(BaseRepository[ApprovalRequest]):
    model = ApprovalRequest

    async def get_by_id(self, id: uuid.UUID) -> ApprovalRequest | None:
        result = await self.db.execute(
            select(ApprovalRequest)
            .where(ApprovalRequest.id == id)
            .options(
                selectinload(ApprovalRequest.agent),
                selectinload(ApprovalRequest.decided_by),
            )
        )
        return result.scalar_one_or_none()

    async def list_by_workspace(
        self,
        workspace_id: uuid.UUID,
        status: ApprovalStatus | None = None,
        limit: int = 50,
    ) -> list[ApprovalRequest]:
        query = (
            select(ApprovalRequest)
            .where(ApprovalRequest.workspace_id == workspace_id)
            .options(
                selectinload(ApprovalRequest.agent),
                selectinload(ApprovalRequest.decided_by),
            )
            .order_by(ApprovalRequest.created_at.desc())
            .limit(limit)
        )
        if status:
            query = query.where(ApprovalRequest.status == status)
        result = await self.db.execute(query)
        return list(result.scalars().all())
