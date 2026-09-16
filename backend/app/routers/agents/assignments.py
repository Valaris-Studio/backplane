# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Response
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.exceptions import ResourceNotFoundError
from app.models.agents.agent import Agent
from app.models.kanban.column import ColumnType
from app.schemas.agents.assignment import (
    AssignmentBoard,
    AssignmentColumn,
    AssignmentRepo,
    AssignmentSkill,
    NextAssignmentRequest,
    NextAssignmentResponse,
    ReservationInfo,
)
from app.schemas.kanban.card import CardRead
from app.services.agents.context_assembly import assemble_context
from app.services.agents.cost import evaluate_circuit_breaker
from app.services.kanban.card import (
    attach_agent_presence,
    attach_pending_approvals,
)
from app.services.scheduling.assignment_service import (
    AgentBusyError,
    AssignmentService,
)
from app.services.scheduling.dispatch_resolver import DispatchResolver
from app.services.skills.skill_service import SkillService
from app.services.workspace_config import WorkspaceConfigService

router = APIRouter(
    prefix="/api/workspaces/{slug}/agents/{agent_id}",
    tags=["agents", "scheduling"],
)


@router.post(
    "/next-assignment",
    response_model=NextAssignmentResponse,
    responses={
        204: {"description": "No eligible card available right now."},
        403: {"description": "Caller is not bound to this agent_id."},
        409: {"description": "Agent has an active execution on another card."},
        423: {"description": "Workspace cost circuit breaker is active."},
    },
)
async def next_assignment(
    agent_id: uuid.UUID,
    body: NextAssignmentRequest | None = None,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    body = body or NextAssignmentRequest()

    result = await db.execute(select(Agent).where(Agent.id == agent_id))
    agent = result.scalar_one_or_none()
    if agent is None:
        raise ResourceNotFoundError("Agent not found", error_code="agent_not_found")

    # Cost circuit breaker: short-circuit before reservation work when the
    # workspace's rolling spend has tripped a "pause"/"kill_runner" action.
    # "alert" still emits the WS event but does not block.
    config = await WorkspaceConfigService(db).get_config(ctx.workspace.id)
    breaker_result = await evaluate_circuit_breaker(
        db,
        workspace_id=ctx.workspace.id,
        breaker_config=config.get("cost_circuit_breaker"),
    )
    if breaker_result.triggered and breaker_result.action in ("pause", "kill_runner"):
        return JSONResponse(
            status_code=423,
            content={
                "detail": "Workspace cost circuit breaker is active",
                "error_code": "circuit_breaker_active",
                "action": breaker_result.action,
                "current_usd": breaker_result.current_usd,
                "threshold_usd": breaker_result.threshold_usd,
            },
        )

    service = AssignmentService(db)
    try:
        bundle = await service.next_assignment(
            workspace=ctx.workspace,
            agent=agent,
            actor_id=ctx.user.id,
            role_override=body.role_override,
            board_filter=body.board_id,
        )
    except AgentBusyError as exc:
        return JSONResponse(
            status_code=409,
            content={
                "detail": exc.detail,
                "error_code": exc.error_code,
                "active_card_id": str(exc.active_card_id) if exc.active_card_id else None,
                "execution_id": str(exc.execution_id) if exc.execution_id else None,
            },
        )

    if bundle is None:
        return Response(status_code=204)

    card = bundle["card"]
    await attach_pending_approvals(db, [card], workspace_id=ctx.workspace.id)
    await attach_agent_presence(db, [card])
    card_read = CardRead.model_validate(card)

    column = bundle["column"]
    board = bundle["board"]
    repo = bundle.get("repo")

    stage = bundle.get("stage") or {}
    stage_llm = stage.get("llm") or {}
    sources = stage_llm.get("context_sources") or []
    # LIFECYCLE-1 A.1: pass the stage's lifecycle array through verbatim
    # so the lane A.2 walker can drive a data-driven role lifecycle.
    raw_lifecycle = stage.get("lifecycle")
    lifecycle = (
        raw_lifecycle if isinstance(raw_lifecycle, list) and raw_lifecycle else None
    )
    # pipeline_expectations renders from config, not DB rows: the agent's own
    # stage (current_role scope) and every configured stage (all_roles scope,
    # for a "pipeline plumber" role). Thread both through — `config` is the
    # workspace pipeline config already loaded above for the breaker check.
    pipeline_stages = (config.get("pipeline_config") or {}).get("stages") or []
    context = await assemble_context(
        db,
        workspace_id=ctx.workspace.id,
        card=card,
        board=board,
        sources=sources,
        stage=stage,
        pipeline_stages=pipeline_stages,
    )

    llm_dispatch = await DispatchResolver(db).resolve(
        stage=stage,
        workspace_id=ctx.workspace.id,
        role=bundle["role"],
    )

    # Skills Registry W3: bundle the board's effective skill set (already
    # slug-ascending from the repo) so the skills_setup step can materialize
    # the bundles. None when empty — old runners must see nothing new.
    effective_skills = await SkillService(db).get_board_effective_skills(board.id)
    skills = [
        AssignmentSkill(
            slug=s.slug,
            name=s.name,
            description=s.description,
            version=s.version,
            content_hash=s.content_hash,
        )
        for s in effective_skills
    ] or None

    return NextAssignmentResponse(
        card=card_read,
        board=AssignmentBoard(id=board.id, slug=board.slug, name=board.name),
        column=AssignmentColumn(
            id=column.id,
            name=column.name,
            column_type=column.column_type.value
            if isinstance(column.column_type, ColumnType)
            else str(column.column_type),
        ),
        repo=AssignmentRepo(
            id=repo.id,
            slug=repo.slug,
            name=repo.name,
            url=repo.url,
            default_branch=repo.default_branch,
            integration_branch=repo.integration_branch,
        ) if repo is not None else None,
        role=bundle["role"],
        stage_action=bundle["stage_action"],
        reservation=ReservationInfo(
            id=bundle["reservation"].id,
            expires_at=bundle["reservation"].expires_at,
        ),
        context=context,
        llm=llm_dispatch,
        lifecycle=lifecycle,
        skills=skills,
    )
