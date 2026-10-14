# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, Depends, Path, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.companion_switch import require_companion_enabled
from app.core.harness import HARNESS_PATTERN
from app.core.private_route import PrivateRoute
from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.schemas.agent_session import (
    AgentSessionEventPage,
    AgentSessionList,
    AgentSessionPage,
    AgentSessionRead,
    CallFilter,
    DisplayState,
    LinkedSessionList,
    SessionCallDetail,
    SessionCallPage,
    SessionPeriodSummary,
    SessionRhythm,
    SessionSort,
    SessionStatus,
    SessionUsageList,
    SessionWorkLinkList,
)
from app.services.agent_session import AgentSessionService
from app.services.session_calls import SessionCallService
from app.services.session_rhythm import SessionRhythmService
from app.services.session_events import publish_invalidations

router = APIRouter(
    prefix="/api/workspaces/{slug}/sessions",
    tags=["agent-sessions"],
    route_class=PrivateRoute,
    dependencies=[Depends(require_companion_enabled)],
)
note_router = APIRouter(
    prefix="/api/workspaces/{slug}/notes",
    tags=["agent-sessions"],
    route_class=PrivateRoute,
    dependencies=[Depends(require_companion_enabled)],
)
card_router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/cards",
    tags=["agent-sessions"],
    route_class=PrivateRoute,
    dependencies=[Depends(require_companion_enabled)],
)


@router.get("", response_model=AgentSessionPage)
async def list_sessions(
    board_id: uuid.UUID | None = None,
    harness: str | None = Query(None, pattern=HARNESS_PATTERN),
    status: SessionStatus | None = None,
    state: list[DisplayState] | None = Query(None),
    q: str | None = Query(None, max_length=100),
    linked_only: bool = False,
    since: datetime | None = None,
    root_only: bool = False,
    sort: SessionSort = "recent",
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=100),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Your captured sessions in this workspace. Every filter applies before
    paging.

    - `state` (repeatable) keeps sessions whose `display_state` is one of the
      given values, derived exactly as each item reports it.
    - `status` filters on the session's own lifecycle: `active` means an event
      in the last 15 minutes, `idle` a longer silence, and `ended` an end
      event or a day of silence.
    - `q` matches title, repository, branch or board name, case-insensitively
      and literally (`%` and `_` are not wildcards).
    - `linked_only` keeps sessions that touched a card or note you can see.
    - `since` keeps sessions active at or after that instant.
    - `root_only` hides subagent threads (sessions that declared a parent).
    - `sort`: `recent` (last activity, the default), `started`, `duration`
      (first to last event), `tokens` (input, output and cache), or `cost`
      (the effective cost whatever its basis; sessions without one last).
      Largest or newest first.

    Pass `next_cursor` back as `cursor` with the same `sort`; a cursor from
    another sort is rejected."""
    return await AgentSessionService(db).list_sessions(
        ctx.workspace.id,
        ctx.user.id,
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


@router.get("/summary", response_model=SessionPeriodSummary)
async def get_sessions_summary(
    since: datetime | None = None,
    board_id: uuid.UUID | None = None,
    harness: str | None = Query(None, pattern=HARNESS_PATTERN),
    root_only: bool = False,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Totals across your sessions in this workspace that match the same
    filters as the list: how many, how many are live, the wall time they
    cover (overlaps once), tokens, and cost per basis. The API-equivalent
    and spend amounts are separate and never add up to one figure."""
    return await AgentSessionService(db).period_summary(
        ctx.workspace.id,
        ctx.user.id,
        board_id=board_id,
        harness=harness,
        root_only=root_only,
        since=since,
    )


@router.get("/{session_id}", response_model=AgentSessionRead)
async def get_session(
    session_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await AgentSessionService(db).get_session(
        ctx.workspace.id, ctx.user.id, session_id
    )


@router.delete("/{session_id}", status_code=204)
async def delete_session(
    session_id: uuid.UUID,
    background: BackgroundTasks,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Delete your session with its events and links. Retries of it that your
    device still has queued are acknowledged and dropped for 30 days. Deleting
    it again is a no-op."""
    invalidations = await AgentSessionService(db).delete_session(
        ctx.workspace.id, ctx.user.id, session_id
    )
    background.add_task(publish_invalidations, invalidations)
    return Response(status_code=204, background=background)


@router.get("/{session_id}/children", response_model=AgentSessionList)
async def list_session_children(
    session_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Subagent threads that named this session as their parent."""
    return await AgentSessionService(db).list_children(
        ctx.workspace.id, ctx.user.id, session_id
    )


@router.get("/{session_id}/events", response_model=AgentSessionEventPage)
async def list_session_events(
    session_id: uuid.UUID,
    action: str | None = Query(None, max_length=200),
    category: str | None = Query(None, max_length=64),
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(100, ge=1, le=500),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """The session timeline in occurrence order."""
    return await AgentSessionService(db).list_events(
        ctx.workspace.id,
        ctx.user.id,
        session_id,
        action=action,
        category=category,
        cursor=cursor,
        limit=limit,
    )


@router.get("/{session_id}/calls", response_model=SessionCallPage)
async def list_session_calls(
    session_id: uuid.UUID,
    filter: CallFilter = "all",
    cursor: str | None = Query(None, max_length=600),
    limit: int = Query(100, ge=1, le=200),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """The session as turns of calls: each prompt opens a turn, every event
    of one tool call (its native call id) is one item, and subagent sessions
    sit at their start. The first page is the newest `limit` items, in
    occurrence order; `next_cursor` pages back in time. Content is only what
    the session's capture level sent: arguments and prompts are previews,
    `withheld` says what was not sent, and output is never in the page.
    `filter=work` keeps calls that touched a card or note you can see,
    `filter=failures` failed calls."""
    return await SessionCallService(db).list_calls(
        ctx.workspace.id,
        ctx.user.id,
        session_id,
        call_filter=filter,
        cursor=cursor,
        limit=limit,
    )


@router.get("/{session_id}/calls/{key}", response_model=SessionCallDetail)
async def get_session_call(
    session_id: uuid.UUID,
    key: str = Path(max_length=600),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Every stored event of one item of `/calls`, as captured at the
    session's level."""
    return await SessionCallService(db).get_call(
        ctx.workspace.id, ctx.user.id, session_id, key
    )


@router.get("/{session_id}/rhythm", response_model=SessionRhythm)
async def get_session_rhythm(
    session_id: uuid.UUID,
    buckets: int = Query(120, ge=1, le=240),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """The session's shape over time from its first event to its last, or to
    now while it is open: timeline entries per bucket by kind, silences longer
    than 5 minutes, and a lane per subagent session. Counts and times only;
    no captured content."""
    return await SessionRhythmService(db).rhythm(
        ctx.workspace.id, ctx.user.id, session_id, buckets=buckets
    )


@router.get("/{session_id}/usage", response_model=SessionUsageList)
async def get_session_usage(
    session_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Token usage and cost per model, with where each cost came from."""
    return await AgentSessionService(db).usage_by_model(
        ctx.workspace.id, ctx.user.id, session_id
    )


@router.get("/{session_id}/links", response_model=SessionWorkLinkList)
async def list_session_links(
    session_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Cards and notes this session changed or consulted through MCP, limited
    to ones that still exist in workspaces you still belong to."""
    return await AgentSessionService(db).list_links(
        ctx.workspace.id, ctx.user.id, session_id
    )


@card_router.get("/{card_id}/sessions", response_model=LinkedSessionList)
async def list_card_sessions(
    card_id: uuid.UUID,
    limit: int | None = Query(None, ge=1, le=200),
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Your own captured sessions that worked on this card, with a rollup of
    their time, tokens and cost. Other members' sessions are never listed,
    even though they can see the card. `limit` lists only the most recently
    active ones; the summary still covers all of them."""
    return await AgentSessionService(db).card_sessions(
        ctx.workspace.id, board_id, card_id, ctx.user.id, limit
    )


@note_router.get("/{note_id}/sessions", response_model=LinkedSessionList)
async def list_note_sessions(
    note_id: uuid.UUID,
    limit: int | None = Query(None, ge=1, le=200),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Your own captured sessions that worked on this note, with a rollup;
    `limit` as for a card."""
    return await AgentSessionService(db).note_sessions(
        ctx.workspace.id, note_id, ctx.user.id, limit
    )
