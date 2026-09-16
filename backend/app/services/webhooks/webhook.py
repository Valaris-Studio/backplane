# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.webhooks.webhook import Webhook
from app.repositories.webhooks.webhook import WebhookRepository
from app.schemas.webhooks.webhook import WebhookCreate, WebhookUpdate
from app.services.webhooks.url_guard import validate_delivery_url


class WebhookService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = WebhookRepository(db)

    async def create(
        self,
        workspace_id: uuid.UUID,
        created_by_id: uuid.UUID,
        data: WebhookCreate,
    ) -> Webhook:
        validate_delivery_url(data.url)
        return await self.repo.create(
            workspace_id=workspace_id,
            created_by_id=created_by_id,
            url=data.url,
            events=[e.value for e in data.events],
            secret=data.secret,
        )

    async def get(
        self, webhook_id: uuid.UUID, workspace_id: uuid.UUID | None = None
    ) -> Webhook:
        # workspace_id scopes the lookup to prevent cross-workspace IDOR: a
        # webhook owned by another workspace is indistinguishable from a
        # missing one (404), never leaked.
        webhook = await self.repo.get_by_id(webhook_id)
        if not webhook or (
            workspace_id is not None and webhook.workspace_id != workspace_id
        ):
            raise ResourceNotFoundError("Webhook not found")
        return webhook

    async def list(
        self, workspace_id: uuid.UUID, is_active: bool | None = None
    ) -> list[Webhook]:
        return await self.repo.list_by_workspace(workspace_id, is_active)

    async def update(
        self,
        webhook_id: uuid.UUID,
        workspace_id: uuid.UUID,
        data: WebhookUpdate,
    ) -> Webhook:
        webhook = await self.get(webhook_id, workspace_id)

        updates = data.model_dump(exclude_unset=True)
        if "url" in updates and updates["url"] is not None:
            validate_delivery_url(updates["url"])
        if "events" in updates and updates["events"] is not None:
            updates["events"] = [e.value for e in data.events]
        return await self.repo.update(webhook, **updates)

    async def delete(self, webhook_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
        webhook = await self.get(webhook_id, workspace_id)
        await self.repo.delete(webhook)
