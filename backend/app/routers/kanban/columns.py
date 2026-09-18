# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace_admin,
    get_workspace_member,
    resolve_board_id,
)
from app.database import get_db
from app.schemas.kanban.column import ColumnCreate, ColumnRead, ColumnReorderRequest, ColumnUpdate
from app.services.kanban.column import ColumnService

router = APIRouter(prefix="/api/workspaces/{slug}/boards/{board_id}/columns", tags=["columns"])


@router.post("", response_model=ColumnRead, status_code=201)
async def create_column(
    data: ColumnCreate,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ColumnService(db)
    return await service.create_column(
        board_id, data, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )


@router.patch("/reorder", status_code=200)
async def reorder_columns(
    data: ColumnReorderRequest,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ColumnService(db)
    await service.reorder_columns(
        board_id, data.column_ids,
        workspace_id=ctx.workspace.id, actor_id=ctx.user.id,
    )
    return {"status": "ok"}


@router.patch("/{column_id}", response_model=ColumnRead)
async def update_column(
    column_id: uuid.UUID,
    data: ColumnUpdate,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ColumnService(db)
    return await service.update_column(
        column_id, board_id, data, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )


@router.delete("/{column_id}", status_code=204)
async def delete_column(
    column_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ColumnService(db)
    await service.delete_column(
        column_id, board_id, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )
