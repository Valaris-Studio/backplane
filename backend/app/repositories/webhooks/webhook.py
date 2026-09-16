# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.webhooks.webhook import Webhook
from app.utils import utcnow


class WebhookRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def create(self, **kwargs) -> Webhook:
        webhook = Webhook(**kwargs)
        self.db.add(webhook)
        await self.db.flush()
        await self.db.refresh(webhook)
        return webhook

    async def get_by_id(self, webhook_id: uuid.UUID) -> Webhook | None:
        result = await self.db.execute(
            select(Webhook).where(Webhook.id == webhook_id)
        )
        return result.scalar_one_or_none()

    async def list_by_workspace(
        self, workspace_id: uuid.UUID, is_active: bool | None = None
    ) -> list[Webhook]:
        stmt = (
            select(Webhook)
            .where(Webhook.workspace_id == workspace_id)
            .order_by(Webhook.created_at.desc())
        )
        if is_active is not None:
            stmt = stmt.where(Webhook.is_active == is_active)
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def list_active_for_event(
        self, workspace_id: uuid.UUID, event: str
    ) -> list[Webhook]:
        """Get all active webhooks subscribed to a specific event."""
        stmt = (
            select(Webhook)
            .where(
                Webhook.workspace_id == workspace_id,
                Webhook.is_active.is_(True),
            )
        )
        result = await self.db.execute(stmt)
        # Filter by event in Python since events is a JSON array
        webhooks = result.scalars().all()
        return [w for w in webhooks if event in w.events]

    async def update(self, webhook: Webhook, **kwargs) -> Webhook:
        for key, value in kwargs.items():
            setattr(webhook, key, value)
        await self.db.flush()
        await self.db.refresh(webhook)
        return webhook

    async def delete(self, webhook: Webhook) -> None:
        await self.db.delete(webhook)
        await self.db.flush()

    async def record_delivery(
        self, webhook_id: uuid.UUID, success: bool
    ) -> None:
        if success:
            await self.db.execute(
                update(Webhook)
                .where(Webhook.id == webhook_id)
                .values(
                    last_delivered_at=utcnow(),
                    failure_count=0,
                )
            )
        else:
            await self.db.execute(
                update(Webhook)
                .where(Webhook.id == webhook_id)
                .values(failure_count=Webhook.failure_count + 1)
            )
        await self.db.flush()
