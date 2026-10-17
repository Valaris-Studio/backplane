# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from urllib.parse import quote

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import iterate_in_threadpool

from app.core.companion_switch import require_companion_enabled
from app.core.private_route import PrivateContentRoute
from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.session_content import (
    INLINE_IMAGE_MEDIA_TYPES,
    ContentBodyPage,
    ContentChannel,
    ContentPage,
    ContentWindow,
    ContentWindowMode,
    SelectedContentMetadata,
    SelectedContentRequest,
)
from app.services.session_content import AgentSessionContentService, download_name
from app.services.session_content_cursor import MAX_WINDOW_CURSOR_LENGTH
from app.services.storage.local import STORED_FILE_CSP

router = APIRouter(
    prefix="/api/workspaces/{slug}/sessions/{session_id}/contents",
    tags=["agent-sessions"],
    route_class=PrivateContentRoute,
    dependencies=[Depends(require_companion_enabled)],
)


@router.get("", response_model=ContentPage)
async def list_session_contents(
    session_id: uuid.UUID,
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(100, ge=1, le=200),
    channel: ContentChannel | None = None,
    call_id: str | None = Query(None, max_length=200),
    event_id: str | None = Query(None, max_length=64),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Your session's captured content in source order: prompts, replies,
    tool input and output, attachments and native records, with what was and
    was not captured (`coverage`). Text bodies page through `/body`; others
    are offered by `/download` (`render`). Never readable by agent keys or
    the agents the companion launches."""
    return await AgentSessionContentService(db).list_contents(
        ctx.workspace.id,
        ctx.user.id,
        session_id,
        cursor=cursor,
        limit=limit,
        channel=channel,
        call_id=call_id,
        event_id=event_id,
    )


@router.get("/window", response_model=ContentWindow)
async def get_session_content_window(
    session_id: uuid.UUID,
    mode: ContentWindowMode = "latest",
    cursor: str | None = Query(None, min_length=1, max_length=MAX_WINDOW_CURSOR_LENGTH),
    anchor_id: uuid.UUID | None = None,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """A bounded metadata and preview window, in durable source order.
    Replay `window_cursor` with `refresh` to retain the original range;
    late insertions exceeding 100 records require deliberate navigation."""
    return await AgentSessionContentService(db).content_window(
        ctx.workspace.id,
        ctx.user.id,
        session_id,
        mode=mode,
        cursor=cursor,
        anchor_id=anchor_id,
    )


@router.post("/metadata", response_model=SelectedContentMetadata)
async def get_selected_content_metadata(
    session_id: uuid.UUID,
    data: SelectedContentRequest,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Revalidate selected records in source order, without previews or bodies.
    Unavailable IDs identify only requested records absent from this session."""
    return await AgentSessionContentService(db).selected_metadata(
        ctx.workspace.id, ctx.user.id, session_id, data.content_ids
    )


@router.get("/{content_id}/body", response_model=ContentBodyPage)
async def get_session_content_body(
    session_id: uuid.UUID,
    content_id: uuid.UUID,
    offset: int = Query(0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """One page (at most 256 KiB, cut on a character boundary) of a text
    body; pass `next_offset` back as `offset`."""
    return await AgentSessionContentService(db).body_page(
        ctx.workspace.id, ctx.user.id, session_id, content_id, offset
    )


@router.get("/{content_id}/download")
async def download_session_content(
    session_id: uuid.UUID,
    content_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """The body's bytes as stored, as a file; raster images may display
    inline. Never executed, sniffed or fetched from elsewhere."""
    content, body = await AgentSessionContentService(db).download(
        ctx.workspace.id, ctx.user.id, session_id, content_id
    )
    inline = content.media_type in INLINE_IMAGE_MEDIA_TYPES
    headers = {
        # identity also keeps GZipMiddleware off, which would drop Content-Length.
        "Content-Encoding": "identity",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": STORED_FILE_CSP,
        "Content-Disposition": (
            f"{'inline' if inline else 'attachment'}; "
            f"filename*=UTF-8''{quote(download_name(content), safe='')}"
        ),
        "Content-Length": str(content.byte_count),
    }
    if isinstance(body, bytes):
        return Response(body, media_type=content.media_type, headers=headers)
    return StreamingResponse(
        iterate_in_threadpool(body), media_type=content.media_type, headers=headers
    )
