# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 3 — Notification HTTP API (contract §"API surface").

Current-user-scoped (NOT under /api/workspaces/{slug}): these are cross-workspace
user-owned feeds; the optional `?workspace=<slug>` narrows + re-verifies
membership. Thin router — parse request, call the service, return the schema.

ROUTE ORDER: the static paths (/unread-count, /read-all, /preferences, /channels)
are declared BEFORE the `/{notification_id}` param route so the param route never
shadows them (a GET /unread-count must not resolve as notification_id="unread-count").
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.notifications import (
    ChannelsRead,
    NotificationPreferenceRead,
    NotificationPreferenceUpdate,
    NotificationRead,
    UnreadCountRead,
)
from app.services.notifications.service import NotificationApiService

router = APIRouter(prefix="/api/notifications", tags=["notifications"])


@router.get("", response_model=list[NotificationRead])
async def list_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    workspace: str | None = Query(default=None),
    limit: int = Query(default=50, le=100),
    before: datetime | None = Query(default=None),
    unread: bool = Query(default=False),
):
    service = NotificationApiService(db)
    workspace_id = await service.resolve_workspace_id(user.id, workspace)
    return await service.list_for_user(
        user.id,
        workspace_id=workspace_id,
        limit=limit,
        before=before,
        unread_only=unread,
    )


@router.get("/unread-count", response_model=UnreadCountRead)
async def unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    workspace: str | None = Query(default=None),
):
    service = NotificationApiService(db)
    workspace_id = await service.resolve_workspace_id(user.id, workspace)
    count = await service.unread_count(user.id, workspace_id=workspace_id)
    return UnreadCountRead(count=count)


@router.post("/read-all")
async def read_all(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    workspace: str | None = Query(default=None),
):
    service = NotificationApiService(db)
    workspace_id = await service.resolve_workspace_id(user.id, workspace)
    await service.mark_all_read(user.id, workspace_id=workspace_id)
    return {}


@router.get("/preferences", response_model=NotificationPreferenceRead)
async def get_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    workspace: str = Query(...),
):
    service = NotificationApiService(db)
    workspace_id = await service.resolve_workspace_id(user.id, workspace)
    return await service.get_preferences(user.id, workspace_id)


@router.put("/preferences", response_model=NotificationPreferenceRead)
async def put_preferences(
    data: NotificationPreferenceUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    workspace: str = Query(...),
):
    service = NotificationApiService(db)
    workspace_id = await service.resolve_workspace_id(user.id, workspace)
    return await service.put_preferences(
        user.id,
        workspace_id,
        relevance_scope=data.relevance_scope,
        category_overrides=data.category_overrides,
        muted=data.muted,
    )


@router.get("/channels", response_model=ChannelsRead)
async def list_channels(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = NotificationApiService(db)
    return ChannelsRead(channels=service.list_channels())


@router.post("/{notification_id}/read", response_model=NotificationRead)
async def read_notification(
    notification_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = NotificationApiService(db)
    return await service.mark_read(user.id, notification_id)
