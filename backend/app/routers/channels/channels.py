# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    get_workspace_member,
)
from app.database import get_db
from app.schemas.channels.channel import (
    ChannelCreate,
    ChannelListRead,
    ChannelRead,
    ChannelUpdate,
)
from app.services.channels.channel import ChannelService

router = APIRouter(
    prefix="/api/workspaces/{slug}/channels",
    tags=["channels"],
)


@router.get("", response_model=list[ChannelListRead] | list[ChannelRead])
async def list_channels(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
    summary: bool = Query(
        default=False,
        description=(
            "Drop `metadata_json` from each row. Default false — MCP "
            "list_channels keeps the full rows."
        ),
    ),
):
    service = ChannelService(db)
    channels = await service.list_channels(ctx.workspace.id)
    if summary:
        return [ChannelListRead.model_validate(c) for c in channels]
    return channels


@router.post("", response_model=ChannelRead, status_code=201)
async def create_channel(
    data: ChannelCreate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = ChannelService(db)
    return await service.create_channel(ctx.workspace.id, data, ctx.user.id)


@router.get("/{channel_id}", response_model=ChannelRead)
async def get_channel(
    channel_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ChannelService(db)
    return await service.get_channel(channel_id, ctx.workspace.id)


@router.put("/{channel_id}", response_model=ChannelRead)
async def update_channel(
    channel_id: uuid.UUID,
    data: ChannelUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = ChannelService(db)
    return await service.update_channel(channel_id, ctx.workspace.id, data, actor_id=ctx.user.id)


@router.delete("/{channel_id}", status_code=204)
async def delete_channel(
    channel_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    service = ChannelService(db)
    await service.delete_channel(channel_id, ctx.workspace.id, actor_id=ctx.user.id)
