# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP surface for the PAR-2 merge queue.

Thin: parse, dispatch to MergeQueueService, return schema.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    get_workspace_member,
)
from app.database import get_db
from app.exceptions import ResourceNotFoundError
from app.schemas.merge_queue import (
    MergeQueueEnqueueRequest,
    MergeQueueEntryRead,
    MergeQueueReEnqueueRequest,
)
from app.services.merge_queue import MergeQueueService

router = APIRouter(
    prefix="/api/workspaces/{slug}/merge-queue",
    tags=["merge-queue"],
)

# 30 days. The ceiling is what keeps the merged arm bounded — without it the
# param is just an unbounded table scan spelled differently.
MERGED_LOOKBACK_MAX_HOURS = 24 * 30


@router.post("/enqueue", response_model=MergeQueueEntryRead)
async def enqueue_merge(
    payload: MergeQueueEnqueueRequest,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MergeQueueService(db, event_bus=event_bus)
    entry, _created = await service.enqueue(
        card_id=payload.card_id,
        repo_id=payload.repo_id,
        integration_branch=payload.integration_branch,
        pr_url=payload.pr_url,
        pr_branch=payload.pr_branch,
        workspace_id=ctx.workspace.id,
        actor_id=ctx.user.id,
    )
    return entry


@router.get("", response_model=list[MergeQueueEntryRead])
async def list_merge_queue(
    merged_within_hours: int | None = Query(
        default=None,
        ge=1,
        le=MERGED_LOOKBACK_MAX_HOURS,
        description=(
            "Also return entries merged within this many hours. Omitted, the "
            "listing carries only in-flight entries."
        ),
    ),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MergeQueueService(db)
    return await service.list_workspace_active(
        workspace_id=ctx.workspace.id,
        merged_within_hours=merged_within_hours,
    )


@router.get("/{entry_id}", response_model=MergeQueueEntryRead)
async def get_merge_queue_entry(
    entry_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MergeQueueService(db)
    entry = await service.repo.get(entry_id)
    if entry is None or entry.workspace_id != ctx.workspace.id:
        raise ResourceNotFoundError("merge queue entry not found")
    return entry


@router.post("/re-enqueue", response_model=MergeQueueEntryRead)
async def re_enqueue_merge_queue_entry(
    payload: MergeQueueReEnqueueRequest,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Re-queue the parent merge-queue entry for a card.

    PAR-3c: invoked by the consolidator-role pipeline once it has resolved
    the rebase conflict. Membership-gated; admin role not required because
    re-enqueue is a normal pipeline action, not a destructive admin override.
    """
    service = MergeQueueService(db, event_bus=event_bus)
    entry = await service.repo.get_by_card_id(payload.card_id)
    if entry is None or entry.workspace_id != ctx.workspace.id:
        raise ResourceNotFoundError("merge queue entry not found")
    return await service.re_enqueue_parent(payload.card_id, workspace_id=ctx.workspace.id, actor_id=ctx.user.id)


@router.post("/{entry_id}/cancel", status_code=204)
async def cancel_merge_queue_entry(
    entry_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = MergeQueueService(db)
    entry = await service.repo.get(entry_id)
    if entry is None or entry.workspace_id != ctx.workspace.id:
        raise ResourceNotFoundError("merge queue entry not found")
    await service.cancel(entry_id)
