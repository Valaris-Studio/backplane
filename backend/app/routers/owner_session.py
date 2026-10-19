# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.core.companion_switch import require_companion_enabled
from app.core.harness import HARNESS_PATTERN
from app.core.private_route import PrivateRoute
from app.database import get_db
from app.models.user import User
from app.schemas.agent_session import DisplayState, SessionStatus
from app.schemas.owner_session import (
    OwnerSessionOverview,
    OwnerSessionPage,
    OwnerSessionSort,
)
from app.services.owner_session import OwnerSessionService

router = APIRouter(
    prefix="/api/me/sessions",
    tags=["agent-sessions"],
    route_class=PrivateRoute,
    dependencies=[Depends(require_companion_enabled)],
)


@router.get("", response_model=OwnerSessionPage)
async def list_owner_sessions(
    workspace_id: uuid.UUID | None = None,
    board_id: uuid.UUID | None = None,
    harness: str | None = Query(None, pattern=HARNESS_PATTERN),
    status: SessionStatus | None = None,
    state: list[DisplayState] | None = Query(None),
    q: str | None = Query(None, max_length=100),
    linked_only: bool = False,
    since: datetime | None = None,
    root_only: bool = True,
    sort: OwnerSessionSort = "recent",
    cursor: str | None = Query(None, max_length=600),
    limit: int = Query(40, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Your session metadata across current workspace memberships.

    Filters precede global keyset pagination. Continue with the same filters;
    the cursor retains its capture-state evaluation time, while current access
    is checked again. This is a live list, not an immutable historical snapshot.
    """
    return await OwnerSessionService(db).list_sessions(
        user.id,
        workspace_id=workspace_id,
        board_id=board_id,
        harness=harness,
        status=status,
        states=state,
        q=q,
        linked_only=linked_only,
        since=since,
        root_only=root_only,
        sort=sort,
        cursor=cursor,
        limit=limit,
    )


@router.get("/overview", response_model=OwnerSessionOverview)
async def owner_session_overview(
    active_limit: int = Query(6, ge=1, le=6),
    recent_limit: int = Query(6, ge=1, le=6),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Active capture and other recent root sessions under one evaluation time."""
    return await OwnerSessionService(db).overview(
        user.id,
        active_limit=active_limit,
        recent_limit=recent_limit,
    )
