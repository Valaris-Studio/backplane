# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.private_route import PrivateContentRoute
from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.schemas.notes.history import NoteRevisionComparison, NoteRevisionDetail, NoteRevisionPage
from app.schemas.notes.note import NoteEdit, NoteRead
from app.services.notes.history import NoteHistoryService
from app.services.notes.note import NoteService

async def _workspace_board() -> None:
    return None


def _history_router(*, board_scoped: bool) -> APIRouter:
    router = APIRouter(route_class=PrivateContentRoute)
    # FastAPI must see the real path dependency only on board-scoped routes.
    board_scope = resolve_board_id if board_scoped else _workspace_board

    @router.post("/{note_id}/edit", response_model=NoteRead)
    async def edit_note(
        note_id: uuid.UUID, data: NoteEdit,
        board_id: uuid.UUID | None = Depends(board_scope),
        ctx: WorkspaceContext = Depends(get_workspace),
        db: AsyncSession = Depends(get_db, scope="function"),
    ):
        return await NoteService(db).edit_note(note_id, ctx.workspace.id, data,
            ctx.user.id, board_id=board_id)


    @router.get("/{note_id}/revisions", response_model=NoteRevisionPage)
    async def list_revisions(
        note_id: uuid.UUID, limit: int = Query(default=50, ge=1, le=100),
        before_revision: int | None = Query(default=None, ge=1),
        board_id: uuid.UUID | None = Depends(board_scope),
        ctx: WorkspaceContext = Depends(get_workspace),
        db: AsyncSession = Depends(get_db, scope="function"),
    ):
        return await NoteHistoryService(db).list(note_id, ctx.workspace.id, ctx.user.id,
            board_id=board_id, limit=limit, before_revision=before_revision)


    # Literal comparison must precede the numbered revision destination.
    @router.get("/{note_id}/revisions/compare", response_model=NoteRevisionComparison)
    async def compare_revisions(
        note_id: uuid.UUID, from_revision: int = Query(ge=1), to_revision: int = Query(ge=1),
        board_id: uuid.UUID | None = Depends(board_scope),
        ctx: WorkspaceContext = Depends(get_workspace),
        db: AsyncSession = Depends(get_db, scope="function"),
    ):
        return await NoteHistoryService(db).compare(note_id, from_revision, to_revision,
            ctx.workspace.id, ctx.user.id, board_id=board_id)


    @router.get("/{note_id}/revisions/{revision}", response_model=NoteRevisionDetail)
    async def get_revision(
        note_id: uuid.UUID, revision: int,
        board_id: uuid.UUID | None = Depends(board_scope),
        ctx: WorkspaceContext = Depends(get_workspace),
        db: AsyncSession = Depends(get_db, scope="function"),
    ):
        return await NoteHistoryService(db).detail(note_id, revision, ctx.workspace.id,
            ctx.user.id, board_id=board_id)

    return router


router = _history_router(board_scoped=False)
board_router = _history_router(board_scoped=True)
