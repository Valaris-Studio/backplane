# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.schemas.kanban.board_health import BoardHealthRead, EscalatedCardInfo, EscalationResult
from app.services.kanban.board_health import BoardHealthService

router = APIRouter(prefix="/api/workspaces/{slug}/boards/{board_id}", tags=["boards"])


@router.get("/health", response_model=BoardHealthRead)
async def get_board_health(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardHealthService(db)
    return await service.get_health(board_id, ctx.workspace.id)


@router.post("/health/escalate", response_model=EscalationResult)
async def escalate_stale_cards(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardHealthService(db)
    escalated = await service.escalate_stale_cards(
        board_id, ctx.workspace.id, ctx.user.id,
    )
    return EscalationResult(
        escalated=[EscalatedCardInfo(**e) for e in escalated],
    )
