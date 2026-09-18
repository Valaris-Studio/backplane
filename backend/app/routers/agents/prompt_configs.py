# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, Depends, Query
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.agents.prompt_config import (
    PromptConfigCreate,
    PromptConfigRead,
    PromptConfigUpdate,
    PromptStageDefault,
)
from app.services.agents.prompt_config import PromptConfigService
from app.services.agents.prompt_defaults import (
    get_prompt_defaults_with_synthesis,
)
from app.services.workspace_config import WorkspaceConfigService

router = APIRouter(prefix="/api/workspaces/{slug}/prompt-configs", tags=["prompt-configs"])


@router.get("", response_model=list[PromptConfigRead])
async def list_prompt_configs(
    team_role: str | None = Query(None),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = PromptConfigService(db)
    return await service.list_configs(ctx.workspace.id, team_role)


@router.get("/defaults", response_model=list[PromptStageDefault])
async def get_prompt_defaults(
    role: str | None = None,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    workspace_config = await WorkspaceConfigService(db).get_config(ctx.workspace.id)
    return get_prompt_defaults_with_synthesis(
        workspace_config.get("pipeline_config"), role
    )


@router.get("/{config_ident}", response_model=PromptConfigRead)
async def get_prompt_config(
    config_ident: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = PromptConfigService(db)
    config_id = await service.resolve_ident(config_ident, ctx.workspace.id)
    return await service.get_config(config_id, workspace_id=ctx.workspace.id)


@router.post("", response_model=PromptConfigRead, status_code=201)
async def create_prompt_config(
    data: PromptConfigCreate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = PromptConfigService(db)
    return await service.create_config(ctx.workspace.id, data, ctx.user.id)


@router.patch("/{config_ident}", response_model=PromptConfigRead)
async def update_prompt_config(
    config_ident: str,
    data: PromptConfigUpdate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = PromptConfigService(db)
    config_id = await service.resolve_ident(config_ident, ctx.workspace.id)
    return await service.update_config(
        config_id, data, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )


@router.get("/{config_ident}/export")
async def export_prompt_config(
    config_ident: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = PromptConfigService(db)
    config_id = await service.resolve_ident(config_ident, ctx.workspace.id)
    envelope = await service.export_config(
        config_id, workspace_id=ctx.workspace.id, workspace_slug=ctx.workspace.slug
    )
    slug = envelope["data"]["slug"]
    return JSONResponse(
        content=envelope,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{slug}.valaris.prompt_config.json"'
            )
        },
    )


@router.delete("/{config_ident}", status_code=204)
async def delete_prompt_config(
    config_ident: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = PromptConfigService(db)
    config_id = await service.resolve_ident(config_ident, ctx.workspace.id)
    await service.delete_config(
        config_id, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )
