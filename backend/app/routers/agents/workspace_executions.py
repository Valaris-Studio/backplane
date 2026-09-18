# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.agents.execution import ExecutionListRead, ExecutionRead
from app.services.agents.execution import ExecutionService

router = APIRouter(
    prefix="/api/workspaces/{slug}/executions", tags=["agent-executions"]
)


@router.get("/skipped-card-ids", response_model=list[str])
async def list_skipped_card_ids(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Card ids the board should badge as "needs prompt" — the union of
    cards_affected across the workspace's `skipped` executions, in one request
    instead of one GET /executions?card_id= per card."""
    service = ExecutionService(db)
    return await service.skipped_card_ids(ctx.workspace.id)


@router.get("", response_model=list[ExecutionListRead] | list[ExecutionRead])
async def list_workspace_executions(
    response: Response,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
    status: str | None = Query(None),
    agent_id: uuid.UUID | None = Query(None),
    role: str | None = Query(None),
    card_id: uuid.UUID | None = Query(None),
    board_id: uuid.UUID | None = Query(None),
    action: str | None = Query(None),
    outcome: str | None = Query(
        None,
        description=(
            "Loop-iteration outcome (worked, nothing_ready, blocked_on_human, "
            "objective_complete). Matches the runner's structured "
            "`outcome=<value>` token in output_summary, not free prose."
        ),
    ),
    q: str | None = Query(
        None, description="Case-insensitive search across both summaries."
    ),
    since: datetime | None = Query(
        None, description="Only executions started at or after this instant."
    ),
    until: datetime | None = Query(
        None, description="Only executions started at or before this instant."
    ),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    summary: bool = Query(
        default=False,
        description=(
            "Drop `input_prompt` (the full rendered LLM prompt) and "
            "`tool_invocations[]` from each row, and skip their eager load. "
            "No list UI renders either — the detail endpoint serves them. "
            "Default false — MCP list_executions and every existing client "
            "keep the full rows."
        ),
    ),
):
    """The response body stays a bare array — the unpaged count for the same
    filters rides the `X-Total-Count` header, so paging could be added without
    breaking any existing consumer's `Execution[]` shape."""
    service = ExecutionService(db)
    executions, total = await service.list_workspace_executions_page(
        ctx.workspace.id,
        limit,
        status=status,
        agent_id=agent_id,
        role=role,
        card_id=card_id,
        board_id=board_id,
        action=action,
        outcome=outcome,
        q=q,
        since=since,
        until=until,
        offset=offset,
        with_tool_invocations=not summary,
    )
    response.headers["X-Total-Count"] = str(total)
    if summary:
        return [ExecutionListRead.model_validate(e) for e in executions]
    return executions


# Declared last on purpose: FastAPI matches in registration order, so the
# literal /skipped-card-ids above must be registered before this path param
# or it would parse as an execution_id and 422.
@router.get("/{execution_id}", response_model=ExecutionRead)
async def get_workspace_execution(
    execution_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """One execution by id. Detail pages read this instead of scanning the
    newest-50 list, which silently rendered blank for older executions."""
    service = ExecutionService(db)
    execution = await service.get_workspace_execution(ctx.workspace.id, execution_id)
    if execution is None:
        raise HTTPException(status_code=404, detail="Execution not found")
    return execution
