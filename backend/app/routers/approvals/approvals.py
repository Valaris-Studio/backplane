# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers
from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.models.approvals.approval import ApprovalStatus
from app.schemas.approvals.approval import ApprovalCreate, ApprovalDecide, ApprovalRead
from app.services.approvals.approval import ApprovalService

router = APIRouter(
    prefix="/api/workspaces/{slug}/approvals",
    tags=["approvals"],
)


@router.post("", response_model=ApprovalRead, status_code=201)
async def create_approval(
    data: ApprovalCreate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ApprovalService(db)
    return await service.create_approval(ctx.workspace.id, data)


@router.get("", response_model=list[ApprovalRead])
async def list_approvals(
    status: ApprovalStatus | None = Query(default=None),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ApprovalService(db)
    return await service.list_approvals(ctx.workspace.id, status)


@router.get("/{approval_id}", response_model=ApprovalRead)
async def get_approval(
    approval_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ApprovalService(db)
    return await service.get_approval(approval_id, ctx.workspace.id)


# Deciding is the HUMAN half of the approvals contract: `decide_approval` is
# an MCP tool, and an agent key resolves to its creating user (a workspace
# member), so without this guard an agent with the tool allowlisted could
# approve its own request — e.g. a skill proposal filed at risk 60.
@router.post(
    "/{approval_id}/decide",
    response_model=ApprovalRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def decide_approval(
    approval_id: uuid.UUID,
    data: ApprovalDecide,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ApprovalService(db)
    return await service.decide(approval_id, ctx.workspace.id, ctx.user.id, data)
