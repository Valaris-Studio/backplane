# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers
from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.agents.team import (
    RoleWarning,
    TeamCreate,
    TeamMemberAdd,
    TeamMemberRead,
    TeamRead,
    TeamUpdate,
)
from app.services.agents.team import TeamService

router = APIRouter(prefix="/api/workspaces/{slug}/teams", tags=["agent-teams"])


@router.get("", response_model=list[TeamRead])
async def list_teams(
    include_inactive: bool = Query(False),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    teams = await service.list_teams(ctx.workspace.id, include_inactive)
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    results = []
    for team in teams:
        read = await _enrich_team_read(db, team, pipeline_roles)
        results.append(read)
    return results


@router.post("", response_model=TeamRead, dependencies=[Depends(forbid_agent_callers)])
async def create_team(
    data: TeamCreate,
    response: Response,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    team, created = await service.create_team(ctx.workspace.id, data, ctx.user.id)
    response.status_code = 201 if created else 200
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    return await _enrich_team_read(db, team, pipeline_roles)


@router.get("/{team_slug}/export")
async def export_team(
    team_slug: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    envelope = await service.export_team(
        ctx.workspace.id, ctx.workspace.slug, team_slug
    )
    return JSONResponse(
        content=envelope,
        headers={
            "Content-Disposition": (
                f'attachment; filename="{team_slug}.valaris.team.json"'
            )
        },
    )


@router.get("/{team_ident}", response_model=TeamRead)
async def get_team(
    team_ident: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    team = await service.get_team_by_identifier(team_ident, ctx.workspace.id)
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    return await _enrich_team_read(db, team, pipeline_roles)


@router.patch("/{team_ident}", response_model=TeamRead, dependencies=[Depends(forbid_agent_callers)])
async def update_team(
    team_ident: str,
    data: TeamUpdate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    team = await service.get_team_by_identifier(team_ident, ctx.workspace.id)
    team = await service.update_team(team.id, data)
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    return await _enrich_team_read(db, team, pipeline_roles)


@router.delete("/{team_ident}", response_model=TeamRead, dependencies=[Depends(forbid_agent_callers)])
async def deactivate_team(
    team_ident: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    team = await service.get_team_by_identifier(team_ident, ctx.workspace.id)
    team = await service.deactivate_team(team.id)
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    return await _enrich_team_read(db, team, pipeline_roles)


@router.post("/{team_ident}/members", response_model=TeamRead, status_code=201, dependencies=[Depends(forbid_agent_callers)])
async def add_member(
    team_ident: str,
    data: TeamMemberAdd,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    service = TeamService(db)
    team = await service.get_team_by_identifier(team_ident, ctx.workspace.id)
    await service.add_member(team.id, data)
    team = await service.get_team(team.id)
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    return await _enrich_team_read(db, team, pipeline_roles)


@router.delete("/{team_ident}/members/{agent_id}", response_model=TeamRead, dependencies=[Depends(forbid_agent_callers)])
async def remove_member(
    team_ident: str,
    agent_id: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    import uuid

    service = TeamService(db)
    team = await service.get_team_by_identifier(team_ident, ctx.workspace.id)
    await service.remove_member(team.id, uuid.UUID(agent_id))
    team = await service.get_team(team.id)
    pipeline_roles = await service.pipeline_stage_roles(ctx.workspace.id)
    return await _enrich_team_read(db, team, pipeline_roles)


async def _enrich_team_read(
    db: AsyncSession, team, pipeline_roles: set[str]
) -> TeamRead:
    """Build TeamRead with agent name/type + role_warnings populated.

    `pipeline_roles` is the set of role names declared in the workspace's
    pipeline_config; the caller fetches it once per request so list endpoints
    stay O(1) in pipeline_config reads regardless of team/member count."""
    from sqlalchemy import select

    from app.models.agents.agent import Agent

    member_reads = []
    for m in team.members:
        result = await db.execute(select(Agent).where(Agent.id == m.agent_id))
        agent = result.scalar_one_or_none()
        agent_name = agent.name if agent else "unknown"
        agent_type = agent.agent_type.value if agent else "unknown"
        warnings = [
            RoleWarning(role=role, reason="not_in_pipeline")
            for role in m.roles
            if role and role not in pipeline_roles
        ]
        member_reads.append(
            TeamMemberRead(
                agent_id=m.agent_id,
                agent_name=agent_name,
                agent_type=agent_type,
                roles=m.roles,
                added_at=m.added_at,
                role_warnings=warnings,
            )
        )

    return TeamRead(
        id=team.id,
        name=team.name,
        slug=team.slug,
        description=team.description,
        workspace_id=team.workspace_id,
        board_id=team.board_id,
        created_by_id=team.created_by_id,
        is_active=team.is_active,
        members=member_reads,
        created_at=team.created_at,
        updated_at=team.updated_at,
    )
