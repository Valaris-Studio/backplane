# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers, get_current_user
from app.core.workspace import WorkspaceContext, get_workspace, get_workspace_admin
from app.database import get_db
from app.models.user import User
from app.schemas.workspace import (
    AddMemberRequest,
    TemporaryPasswordRequest,
    TemporaryPasswordResponse,
    UpdateMemberRoleRequest,
    WorkspaceCreate,
    WorkspaceMemberRead,
    WorkspaceRead,
    WorkspaceSummary,
    WorkspaceSummaryTrimmedActivity,
    WorkspaceUpdate,
)
from app.services.workspace import WorkspaceService

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])


@router.get("", response_model=list[WorkspaceRead])
async def list_workspaces(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    return await service.list_workspaces(user)


@router.post(
    "",
    response_model=WorkspaceRead,
    status_code=201,
    dependencies=[Depends(forbid_agent_callers)],
)
async def create_workspace(
    data: WorkspaceCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    return await service.create_workspace(data, user)


@router.get("/{slug}", response_model=WorkspaceRead)
async def get_workspace_detail(ctx: WorkspaceContext = Depends(get_workspace)):
    return ctx.workspace


@router.get(
    "/{slug}/summary",
    response_model=WorkspaceSummaryTrimmedActivity | WorkspaceSummary,
)
async def get_workspace_summary(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
    summary_activity: bool = Query(
        default=False,
        description=(
            "Strip the changes/before_state/after_state snapshots from the "
            "embedded recent_activity rows. Named distinctly from the "
            "endpoint itself (which is already a summary) so the flag reads "
            "unambiguously at the call site."
        ),
    ),
):
    service = WorkspaceService(db)
    result = await service.get_summary(ctx.workspace.id)
    if summary_activity:
        return WorkspaceSummaryTrimmedActivity.model_validate(result)
    return result


@router.put("/{slug}", response_model=WorkspaceRead)
async def update_workspace(
    data: WorkspaceUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    return await service.update_workspace(ctx.workspace.id, data, actor_id=ctx.user.id)


@router.delete("/{slug}", status_code=204)
async def delete_workspace(
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    await service.delete_workspace(ctx.workspace.id)


@router.get("/{slug}/members", response_model=list[WorkspaceMemberRead])
async def list_members(
    q: str | None = None,
    limit: int | None = None,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    # Optional ?q= turns the list into a capped ILIKE search (autocomplete
    # source). The no-q path is unchanged — full member list.
    if q:
        members = await service.search_members(ctx.workspace.id, q, limit)
    else:
        members = await service.list_members(ctx.workspace.id)
    return [
        WorkspaceMemberRead(
            user_id=m.user_id,
            email=m.user.email,
            name=m.user.name,
            role=m.role,
            joined_at=m.joined_at,
        )
        for m in members
    ]


@router.post("/{slug}/members", status_code=201)
async def add_member(
    data: AddMemberRequest,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    await service.add_member(
        ctx.workspace.id,
        data.email,
        data.role,
        actor_id=ctx.user.id,
        initial_password=data.initial_password,
    )
    return {"status": "ok"}


@router.post(
    "/{slug}/members/{user_id}/temporary-password",
    response_model=TemporaryPasswordResponse,
)
async def set_member_temporary_password(
    user_id: uuid.UUID,
    data: TemporaryPasswordRequest,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    from fastapi import HTTPException

    from app.config import settings

    if not settings.LOCAL_AUTH_ENABLED:
        # A temporary password is unusable without local login — answer like
        # the login route does when the surface is off.
        raise HTTPException(status_code=404, detail="Not Found")
    service = WorkspaceService(db)
    temporary_password = await service.set_member_temporary_password(
        ctx.workspace.id, user_id, actor_id=ctx.user.id, password=data.password
    )
    return TemporaryPasswordResponse(temporary_password=temporary_password)


@router.patch("/{slug}/members/{user_id}", response_model=WorkspaceMemberRead)
async def update_member_role(
    user_id: uuid.UUID,
    data: UpdateMemberRoleRequest,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    member = await service.update_member_role(
        ctx.workspace.id, user_id, data.role, actor_id=ctx.user.id
    )
    return WorkspaceMemberRead(
        user_id=member.user_id,
        email=member.user.email,
        name=member.user.name,
        role=member.role,
        joined_at=member.joined_at,
    )


@router.delete("/{slug}/members/{user_id}", status_code=204)
async def remove_member(
    user_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = WorkspaceService(db)
    await service.remove_member(ctx.workspace.id, user_id, actor_id=ctx.user.id)
