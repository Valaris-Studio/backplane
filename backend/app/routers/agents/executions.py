# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.models.user import User
from app.schemas.agents.execution import (
    ExecutionCreate,
    ExecutionListRead,
    ExecutionRead,
    ExecutionUpdate,
    ExecutionWarningCreate,
    ToolInvocationCreate,
    ToolInvocationRead,
)
from app.services.agents.execution import ExecutionService
from app.services.agents.tool_invocation import ToolInvocationService

router = APIRouter(prefix="/api/agents/{agent_id}/executions", tags=["agent-executions"])


@router.post("", response_model=ExecutionRead, status_code=201)
async def start_execution(
    agent_id: uuid.UUID,
    data: ExecutionCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ExecutionService(db)
    return await service.start_execution(agent_id, data, user_id=user.id)


@router.patch("/{execution_id}", response_model=ExecutionRead)
async def update_execution(
    agent_id: uuid.UUID,
    execution_id: uuid.UUID,
    data: ExecutionUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ExecutionService(db)
    return await service.update_execution(agent_id, execution_id, data, user_id=user.id)


@router.get("", response_model=list[ExecutionListRead] | list[ExecutionRead])
async def list_executions(
    agent_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
    role: str | None = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    summary: bool = Query(
        default=False,
        description=(
            "Drop `input_prompt` and `tool_invocations[]` from each row and "
            "skip their eager load. Default false keeps the full rows."
        ),
    ),
):
    """Newest-first executions for one agent. `limit`/`offset` mirror the
    workspace endpoint (same le=200 ceiling) — this endpoint previously
    returned the repository's hardcoded newest-50 with no way to page past it.
    """
    service = ExecutionService(db)
    executions = await service.list_executions(
        agent_id,
        limit,
        role=role,
        user_id=user.id,
        offset=offset,
        with_tool_invocations=not summary,
    )
    if summary:
        return [ExecutionListRead.model_validate(e) for e in executions]
    return executions


@router.post("/{execution_id}/warnings", status_code=202)
async def record_execution_warning(
    agent_id: uuid.UUID,
    execution_id: uuid.UUID,
    data: ExecutionWarningCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ExecutionService(db)
    await service.record_warning(agent_id, execution_id, data, user_id=user.id)
    return {"status": "recorded"}


@router.post(
    "/{execution_id}/tool-invocations",
    response_model=list[ToolInvocationRead],
    status_code=201,
)
async def record_tool_invocations(
    agent_id: uuid.UUID,
    execution_id: uuid.UUID,
    invocations: list[ToolInvocationCreate],
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = ToolInvocationService(db)
    return await service.record_invocations(
        agent_id, execution_id, invocations, user_id=user.id
    )
