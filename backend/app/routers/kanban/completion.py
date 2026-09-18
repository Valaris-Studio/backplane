# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace, resolve_board_id
from app.database import get_db
from app.schemas.completion import CompletionModeWrite, CompletionPolicyWrite, CompletionPolicyPreview
from app.services.completion_policy import CompletionPolicyService
from app.services.completion import CompletionService
from app.schemas.completion import (
    CompletionSubmit,
    CompletionLand,
    CompletionClaim,
    CompletionResult,
    CompletionRequirements,
    CompletionReadiness,
    CompletionWorkStatus,
    CompletionWorkCursor,
)

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/completion", tags=["completion"]
)


@router.get("/policy")
async def read_policy(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionPolicyService(db).read_policy(
        board_id, ctx.workspace.id, ctx.user.id
    )


@router.post("/policy/preview")
async def preview_policy(
    data: CompletionPolicyPreview,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionPolicyService(db).preview_policy(
        board_id, ctx.workspace.id, ctx.user.id, data.policy, loop_config=data.loop_config,
        template=data.template.model_dump() if data.template is not None else None,
    )


@router.put("/policy")
async def write_policy(
    data: CompletionPolicyWrite,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionPolicyService(db).set_policy(
        board_id, ctx.workspace.id, ctx.user.id, data.policy
    )


@router.put("/cards/{card_id}/mode")
async def write_mode(
    card_id: uuid.UUID,
    data: CompletionModeWrite,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionPolicyService(db).set_mode(
        board_id, ctx.workspace.id, ctx.user.id, card_id, data.completion_mode
    )


@router.get("/cards/{card_id}")
async def read_completion(
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).status(
        board_id, ctx.workspace.id, ctx.user.id, card_id
    )


@router.post("/cards/{card_id}/submit")
async def submit_completion(
    card_id: uuid.UUID,
    data: CompletionSubmit,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).submit(
        board_id, ctx.workspace.id, ctx.user.id, card_id, data
    )


@router.post("/cards/{card_id}/land")
async def land_completion(
    card_id: uuid.UUID,
    data: CompletionLand,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).land(
        board_id, ctx.workspace.id, ctx.user.id, card_id, data
    )


@router.post("/cards/{card_id}/retry")
async def retry_completion(
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).retry(
        board_id, ctx.workspace.id, ctx.user.id, card_id
    )


@router.get("/work", response_model=CompletionWorkStatus)
async def read_work(
    cursor: CompletionWorkCursor | None = None,
    limit: int = Query(default=100, ge=1, le=100),
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).work(
        board_id, ctx.workspace.id, ctx.user.id, cursor=cursor, limit=limit
    )


@router.post("/work/claim")
async def claim_work(
    data: CompletionClaim,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).claim(
        board_id, ctx.workspace.id, ctx.user.id, data
    )


@router.post("/work/{attempt_id}/result")
async def submit_result(
    attempt_id: uuid.UUID,
    data: CompletionResult,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).result(
        board_id, ctx.workspace.id, ctx.user.id, attempt_id, data
    )


@router.get("/requirements", response_model=CompletionRequirements)
async def read_requirements(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).requirements(
        board_id, ctx.workspace.id, ctx.user.id
    )


@router.get("/readiness", response_model=CompletionReadiness)
async def read_readiness(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompletionService(db).readiness(
        board_id, ctx.workspace.id, ctx.user.id
    )
