# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board-level dependency edge listing.

URL: /api/workspaces/{slug}/boards/{board_id}/dependencies

Returns every dependency edge on the board in one call so the kanban table
view can build its within-column dependency tree without an N+1 per-card
fetch. The per-card detail surface still lives in card_dependencies.py.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.schemas.kanban.dependencies import (
    BoardDependencyEdge,
    BoardDependencyValidation,
)
from app.services.kanban.dependencies import DependencyService
from app.services.kanban.dependency_graph import DependencyGraphService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/dependencies",
    tags=["board-dependencies"],
)


@router.get("", response_model=list[BoardDependencyEdge])
async def list_board_dependencies(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = DependencyService(db)
    edges = await service.list_for_board(board_id=board_id)
    return [
        BoardDependencyEdge(card_id=card_id, depends_on_card_id=depends_on_card_id)
        for card_id, depends_on_card_id in edges
    ]


@router.get("/validation", response_model=BoardDependencyValidation)
async def validate_board_dependencies(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await DependencyGraphService(db).validate(board_id=board_id)
