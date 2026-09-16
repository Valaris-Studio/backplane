# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from typing import Any

from fastapi import APIRouter, Body, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    resolve_board_id,
)
from app.database import get_db
from app.repositories.git.git_repo import GitRepoRepository
from app.schemas.completion_context import CompletionContextImpact, ContextSourceKind
from app.schemas.workspace_config import WorkspaceConfigRead, WorkspaceConfigUpdate
from app.services.agents.cost import reset_breaker_dedupe
from app.services.agents.role_labels import get_role_labels
from app.services.export.pipeline_bundle import PipelineBundleService
from app.services.runner_config import build_runner_config
from app.services.workspace_config import WorkspaceConfigService

router = APIRouter(
    prefix="/api/workspaces/{slug}/config",
    tags=["workspace-config"],
)


@router.get("", response_model=WorkspaceConfigRead)
async def get_workspace_config(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = WorkspaceConfigService(db)
    return await service.get_config(ctx.workspace.id)


@router.patch("", response_model=WorkspaceConfigRead)
async def update_workspace_config(
    data: WorkspaceConfigUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    service = WorkspaceConfigService(db)
    return await service.update_config(ctx.workspace.id, data, actor_id=ctx.user.id)


@router.get("/pipeline/export")
async def export_pipeline(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = WorkspaceConfigService(db)
    envelope = await service.export_pipeline(ctx.workspace.id, ctx.workspace.slug)
    return JSONResponse(
        content=envelope,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ctx.workspace.slug}.valaris.pipeline.json"'
            )
        },
    )


@router.get("/bundle/export")
async def export_pipeline_bundle(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Download the workspace's portable config bundle (pipeline + setup
    contract + workspace-scoped prompts) as a JSON attachment."""
    service = PipelineBundleService(db)
    bundle = await service.build_bundle(ctx.workspace.id, ctx.workspace.slug)
    return JSONResponse(
        content=bundle,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ctx.workspace.slug}.valaris.bundle.json"'
            )
        },
    )


@router.post("/bundle/import")
async def import_pipeline_bundle(
    bundle: dict[str, Any] = Body(...),
    dry_run: bool = True,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    """Import a config bundle into the workspace.

    `dry_run=true` (default) returns a preview (created/updated/skipped prompts +
    validation findings) and mutates nothing. `dry_run=false` applies the bundle
    atomically (pipeline update + prompt creates share the request transaction).
    Stale `expected_pipeline_version` → 409; invalid pipeline → 422.
    """
    service = PipelineBundleService(db)
    return await service.import_bundle(
        ctx.workspace.id, ctx.user.id, bundle, dry_run=dry_run
    )


# Role-label registry (card 86ca1421 Phase A). Mounted on a sibling prefix
# so consumers can hit a stable URL without parsing the full config blob.
# Membership-gated; no admin requirement (display labels are read-mostly).
role_labels_router = APIRouter(
    prefix="/api/workspaces/{slug}/role-labels",
    tags=["workspace-config"],
)


@role_labels_router.get("")
async def get_workspace_role_labels(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    return await get_role_labels(db, ctx.workspace.id)


# Resume CTA for the cost circuit breaker (card e244867f).
# Mounted on a sibling prefix because the operation is not strictly a
# config write; it clears in-process dedupe state so the next signal
# re-fires. Persistent state still lives in workspace_configs.cost_circuit_breaker.
breaker_router = APIRouter(
    prefix="/api/workspaces/{slug}/cost-breaker",
    tags=["workspace-config"],
)


@breaker_router.post("/resume")
async def resume_cost_breaker(
    ctx: WorkspaceContext = Depends(get_workspace_admin),
):
    reset_breaker_dedupe(ctx.workspace.id)
    return {"status": "resumed", "workspace_id": str(ctx.workspace.id)}


# Self-service runner onboarding: download a pre-filled runner.yaml +
# mcp-config.json + host-prerequisites checklist for a board, so an operator
# doesn't hand-author the runner config pair. Board-scoped (the config differs
# per board's git repo + the workspace pipeline_config), membership-gated.
runner_config_router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/runner-config",
    tags=["workspace-config"],
)


@runner_config_router.get("")
async def get_board_runner_config(
    ctx: WorkspaceContext = Depends(get_workspace),
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    agent_id: uuid.UUID | None = Query(
        None,
        description="Scope the config to an EXISTING runner. Drops the "
        "'create an agent' prerequisite, names the runner in the key step, "
        "and drops team binding only when the backend verifies it.",
    ),
    db: AsyncSession = Depends(get_db),
):
    """Pre-filled runner config for this board: `runner_yaml`, `mcp_config_json`,
    and a `prerequisites` checklist of host-environment steps the backend can't
    do for the operator (coding-agent CLI, forge auth, and — for a brand-new
    runner — agent key + team binding)."""
    from app.config import settings

    config_service = WorkspaceConfigService(db)
    for_agent: str | None = None
    has_workspace_binding: bool | None = None
    if agent_id is not None:
        agent_context = await config_service.resolve_runner_agent_context(
            agent_id=agent_id,
            user_id=ctx.user.id,
            workspace_id=ctx.workspace.id,
            workspace_slug=ctx.workspace.slug,
        )
        for_agent = agent_context.name
        has_workspace_binding = agent_context.has_workspace_binding

    pipeline_config = (await config_service.get_config(ctx.workspace.id)).get(
        "pipeline_config"
    ) or {}
    repos = await GitRepoRepository(db).list_by_board(board_uuid)
    return build_runner_config(
        api_url=settings.API_URL,
        workspace_slug=ctx.workspace.slug,
        board_id=str(board_uuid),
        pipeline_config=pipeline_config,
        repos=[
            {
                "provider": r.provider.value if r.provider else None,
                "default_branch": r.default_branch,
                "integration_branch": r.integration_branch,
            }
            for r in repos
        ],
        for_agent=for_agent,
        has_workspace_binding=has_workspace_binding,
    )


@router.get("/completion-context-impact", response_model=CompletionContextImpact)
async def completion_context_impact(
    source_kind: ContextSourceKind,
    source_id: uuid.UUID | None = None,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    from app.services.completion_context_impact import CompletionContextImpactService

    return await CompletionContextImpactService(db).read(
        ctx.workspace.id, ctx.user.id, source_kind, source_id,
    )
