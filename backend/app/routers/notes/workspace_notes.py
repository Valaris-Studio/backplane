# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, get_workspace_member
from app.database import get_db
from app.schemas.notes.note import (
    NoteAppend,
    NoteCreate,
    NoteFormat,
    NoteRead,
    NoteSectionReplace,
    NoteSummary,
    NoteUpdate,
)
from app.routers.notes.list_options import build_list_options
from app.services.notes.note import NoteService

router = APIRouter(
    prefix="/api/workspaces/{slug}/notes",
    tags=["workspace-notes"],
)


@router.get("", response_model=list[NoteRead] | list[NoteSummary])
async def list_workspace_notes(
    request: Request,
    response: Response,
    summary_only: bool = Query(
        default=False,
        description="Omit each note's heavy `content` field (id/title/metadata only).",
    ),
    q: str | None = Query(
        default=None,
        description=(
            "Case-insensitive substring search across the note title and its "
            "plain-text body. Applied BEFORE pagination, so a match on the "
            "last page is still found."
        ),
    ),
    order_by: Literal["updated_at", "created_at", "title", "author"] = Query(
        default="updated_at",
        description=(
            "Sort key. `title` sorts case-insensitively; `author` sorts by the "
            "author's display name (name, or email when name is blank)."
        ),
    ),
    direction: Literal["asc", "desc"] = Query(default="desc"),
    pinned_only: bool = Query(default=False),
    authors: list[uuid.UUID] | None = Query(
        default=None, description="Repeat the param to filter on several authors."
    ),
    kinds: list[str] | None = Query(
        default=None, description="Repeat the param to filter on several note kinds."
    ),
    limit: int | None = Query(
        default=None,
        ge=1,
        le=200,
        description=(
            "Page size. OMITTED (the default) returns every matching note "
            "unbounded for existing REST clients. MCP always supplies a limit. "
            "When passed, the unpaged match "
            "count rides the `X-Total-Count` header."
        ),
    ),
    offset: int = Query(default=0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Workspace-level notes (board_id IS NULL).

    Every query param is optional and the response body stays a bare array, so
    a param-less call returns byte-identically what it did before search and
    paging existed — the MCP `list_notes` tool sends nothing but `card_id` /
    `summary_only`.
    """
    service = NoteService(db)
    notes, total = await service.list_notes_page(
        workspace_id=ctx.workspace.id,
        **build_list_options(request, q, order_by, direction, pinned_only, authors, kinds, limit, offset),
    )
    if limit is not None:
        response.headers["X-Total-Count"] = str(total)
    if summary_only:
        return [NoteSummary.from_note(n) for n in notes]
    return notes


@router.post("", response_model=NoteRead, status_code=201)
async def create_workspace_note(
    data: NoteCreate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    return await service.create_note(
        ctx.workspace.id, data, ctx.user.id, data.board_id
    )


@router.get("/resolve", response_model=NoteRead)
async def resolve_workspace_note_by_prefix(
    prefix: str = Query(..., description="UUID prefix fragment (min 4 chars)."),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    # Registered BEFORE GET /{note_id} so the literal 'resolve' segment is never
    # shadowed by the UUID path param (FastAPI matches in declaration order).
    service = NoteService(db)
    return await service.resolve_note_by_prefix(ctx.workspace.id, prefix)


@router.get("/{note_id}", response_model=NoteRead)
async def get_workspace_note(
    note_id: uuid.UUID,
    format: NoteFormat = Query(
        default=NoteFormat.prosemirror,
        description="`prosemirror` (default, raw PM JSON) or `markdown`.",
    ),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    return await service.get_note_read(
        note_id,
        ctx.workspace.id,
        as_markdown=format == NoteFormat.markdown,
    )


@router.put("/{note_id}", response_model=NoteRead)
async def update_workspace_note(
    note_id: uuid.UUID,
    data: NoteUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    return await service.update_note(note_id, ctx.workspace.id, data, actor_id=ctx.user.id)


@router.post("/{note_id}/append", response_model=NoteRead)
async def append_workspace_note(
    note_id: uuid.UUID,
    data: NoteAppend,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    return await service.append_note(note_id, ctx.workspace.id, data, actor_id=ctx.user.id)


@router.post("/{note_id}/replace-section", response_model=NoteRead)
async def replace_workspace_note_section(
    note_id: uuid.UUID,
    data: NoteSectionReplace,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    return await service.replace_note_section(
        note_id, ctx.workspace.id, data, actor_id=ctx.user.id
    )


@router.delete("/{note_id}", status_code=204)
async def delete_workspace_note(
    note_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = NoteService(db)
    await service.delete_note(note_id, ctx.workspace.id, actor_id=ctx.user.id)
