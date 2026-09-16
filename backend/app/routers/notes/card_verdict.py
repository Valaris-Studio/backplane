# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.exceptions import ResourceNotFoundError
from app.schemas.notes.note import CardVerdictRead
from app.services.notes.note import NoteService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/cards/{card_id}",
    tags=["card-verdict"],
)


@router.get("/verdict", response_model=CardVerdictRead)
async def get_card_verdict(
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    verdict = await service.get_card_verdict(card_id, ctx.workspace.id)
    if verdict is None:
        raise ResourceNotFoundError("No verdict found for card")
    return verdict
