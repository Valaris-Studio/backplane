# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.models.user import User
from app.schemas.webhooks.webhook import WebhookCreate, WebhookRead, WebhookUpdate
from app.services.webhooks.webhook import WebhookService

router = APIRouter(tags=["webhooks"])


@router.post(
    "/api/workspaces/{slug}/webhooks",
    response_model=WebhookRead,
    status_code=201,
)
async def create_webhook(
    data: WebhookCreate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    service = WebhookService(db)
    return await service.create(ctx.workspace.id, user.id, data)


@router.get(
    "/api/workspaces/{slug}/webhooks",
    response_model=list[WebhookRead],
)
async def list_webhooks(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
    is_active: bool | None = Query(default=None),
):
    service = WebhookService(db)
    return await service.list(ctx.workspace.id, is_active)


@router.get(
    "/api/workspaces/{slug}/webhooks/{webhook_id}",
    response_model=WebhookRead,
)
async def get_webhook(
    webhook_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = WebhookService(db)
    webhook = await service.get(webhook_id, ctx.workspace.id)
    return webhook


@router.patch(
    "/api/workspaces/{slug}/webhooks/{webhook_id}",
    response_model=WebhookRead,
)
async def update_webhook(
    webhook_id: uuid.UUID,
    data: WebhookUpdate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = WebhookService(db)
    return await service.update(webhook_id, ctx.workspace.id, data)


@router.delete(
    "/api/workspaces/{slug}/webhooks/{webhook_id}",
    status_code=204,
)
async def delete_webhook(
    webhook_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = WebhookService(db)
    await service.delete(webhook_id, ctx.workspace.id)
