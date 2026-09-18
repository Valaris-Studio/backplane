# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.models.activity import ActivityAction, ActivityEntityType
from app.schemas.activity import ActivityListRead, ActivityRead, TimelineResponse
from app.services.activity import ActivityService

router = APIRouter(tags=["activity"])


@router.get(
    "/api/workspaces/{slug}/history",
    response_model=list[ActivityListRead] | list[ActivityRead],
)
async def list_workspace_activity(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
    limit: int = Query(default=50, le=100),
    before: datetime | None = Query(default=None),
    entity_type: ActivityEntityType | None = Query(default=None),
    action: ActivityAction | None = Query(default=None),
    actor_id: uuid.UUID | None = Query(default=None),
    search: str | None = Query(default=None),
    summary: bool = Query(
        default=False,
        description=(
            "Drop the `changes`/`before_state`/`after_state` JSONB snapshots "
            "from each row. The activity feed renders only the prose; the "
            "timeline replay engine reads /timeline, which is unaffected. "
            "Default false — MCP list_activity keeps the full rows."
        ),
    ),
):
    service = ActivityService(db)
    rows = await service.list_workspace_activity(
        ctx.workspace.id, limit, before,
        entity_type=entity_type, action=action, actor_id=actor_id, search=search,
    )
    if summary:
        return [ActivityListRead.model_validate(row) for row in rows]
    return rows


@router.get(
    "/api/workspaces/{slug}/boards/{board_id}/history",
    response_model=list[ActivityListRead] | list[ActivityRead],
)
async def list_board_activity(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
    limit: int = Query(default=50, le=100),
    before: datetime | None = Query(default=None),
    entity_type: ActivityEntityType | None = Query(default=None),
    action: ActivityAction | None = Query(default=None),
    actor_id: uuid.UUID | None = Query(default=None),
    search: str | None = Query(default=None),
    summary: bool = Query(
        default=False,
        description=(
            "Drop the `changes`/`before_state`/`after_state` JSONB snapshots "
            "from each row. The activity feed renders only the prose; the "
            "timeline replay engine reads /timeline, which is unaffected. "
            "Default false — MCP list_activity keeps the full rows."
        ),
    ),
):
    service = ActivityService(db)
    rows = await service.list_board_activity(
        board_id, limit, before,
        entity_type=entity_type, action=action, actor_id=actor_id, search=search,
    )
    if summary:
        return [ActivityListRead.model_validate(row) for row in rows]
    return rows


@router.get(
    "/api/workspaces/{slug}/boards/{board_id}/timeline",
    response_model=TimelineResponse,
)
async def get_board_timeline(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
    # Bounded default: a plain call returns 500 events (each with before/after
    # JSONB snapshots) plus a full-board baseline, not the 5000 ceiling. The
    # replay view that folds the whole log client-side opts back into 5000
    # explicitly (frontend use-timeline.ts). le keeps the hard cap.
    limit: int = Query(default=500, le=5000),
):
    service = ActivityService(db)
    events, truncated = await service.list_board_timeline(board_id, limit)
    baseline = await service.build_board_baseline(board_id)
    return TimelineResponse(
        board_id=board_id,
        generated_at=datetime.now(timezone.utc),
        truncated=truncated,
        events=events,
        baseline=baseline,
    )
