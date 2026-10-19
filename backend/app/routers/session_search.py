# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.companion_switch import require_companion_enabled
from app.core.private_route import PrivateContentRoute
from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.session_search import SessionSearchPage, SessionSearchRequest
from app.services.session_search import SessionSearchService

router = APIRouter(
    prefix="/api/workspaces/{slug}/sessions/{session_id}/search",
    tags=["agent-sessions"],
    route_class=PrivateContentRoute,
    dependencies=[Depends(require_companion_enabled)],
)


@router.post(
    "",
    response_model=SessionSearchPage,
    responses={409: {"description": "The cursor's search is stale"}},
)
async def search_session(
    session_id: uuid.UUID,
    data: SessionSearchRequest,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Find literal text anywhere in your session's retained content and
    calls, including bodies beyond their previews and records captured before
    search existed, once indexed (`coverage` says what is). The query is sent
    in the body and never echoed. Never available to agent keys, the keys the
    companion hands its agents, or devices."""
    return await SessionSearchService(db).search(
        ctx.workspace.id, ctx.user.id, session_id, data
    )
