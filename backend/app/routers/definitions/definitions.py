# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_member,
    resolve_board_id,
)
from app.database import get_db
from app.models.kanban.board import Board
from app.schemas.definitions.definition import DefinitionRead, DefinitionUpsert
from app.services.definitions.definition import DefinitionService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/definitions",
    tags=["definitions"],
)


@router.get("", response_model=DefinitionRead)
async def get_definition(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = DefinitionService(db)
    return await service.get_definition(board_id, ctx.workspace.id)


@router.put("", response_model=DefinitionRead)
async def upsert_definition(
    data: DefinitionUpsert,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = DefinitionService(db)
    return await service.upsert_definition(
        board_id, ctx.workspace.id, data, ctx.user.id
    )


@router.get("/export")
async def export_definition(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    board_slug = await db.scalar(select(Board.slug).where(Board.id == board_id))
    service = DefinitionService(db)
    envelope = await service.export_definition(
        board_id, ctx.workspace.id, ctx.workspace.slug, board_slug
    )
    return JSONResponse(
        content=envelope,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{board_slug}.valaris.definition.json"'
            )
        },
    )
