# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.schemas.kanban.board_context import BoardContextRead
from app.services.kanban.board_context import BoardContextService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}", tags=["board-context"]
)


@router.get("/context", response_model=BoardContextRead)
async def get_board_context(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardContextService(db)
    return await service.get_context(board_id, ctx.workspace.id)
