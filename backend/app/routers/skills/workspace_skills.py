# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace skill registry + starter catalog.

Reads are member-gated, and an agent key may read too — a runner materializing
a board's skills has to fetch the bundles it was pointed at.

Mutations are admin + `forbid_agent_callers`. Skills steer future agent
behavior, so an agent must never author the instructions that govern it —
agent-originated changes arrive via the approvals path (W2 proposals), never
by writing here directly.
"""

from fastapi import APIRouter, Depends, Query, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers
from app.core.workspace import WorkspaceContext, get_workspace, get_workspace_admin
from app.database import get_db
from app.schemas.skills.skill import (
    SkillCatalogEntryRead,
    SkillCreate,
    SkillProposalCreate,
    SkillProposalRead,
    SkillRead,
    SkillVersionCreate,
    SkillVersionDetailRead,
    SkillVersionRead,
)
from app.services.skills.catalog import SKILL_CATALOG
from app.services.skills.skill_service import (
    SkillService,
    build_skill_list_item,
    build_skill_read,
    build_version_detail_read,
    build_version_read,
)

router = APIRouter(prefix="/api/workspaces/{slug}/skills", tags=["skills"])

catalog_router = APIRouter(
    prefix="/api/workspaces/{slug}/skill-catalog", tags=["skills"]
)


@router.get("")
async def list_skills(
    include_archived: bool = Query(default=False),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> dict:
    """Listing items are METADATA only — file contents never ride here."""
    service = SkillService(db)
    skills = await service.list_skills(
        ctx.workspace.id, include_archived=include_archived
    )
    return {
        "skills": [
            build_skill_list_item(s).model_dump(mode="json") for s in skills
        ],
        "count": len(skills),
    }


@router.post("", dependencies=[Depends(forbid_agent_callers)])
async def create_skill(
    data: SkillCreate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> JSONResponse:
    """Create a skill with its files as draft version 1.

    Idempotent on slug: an existing slug returns the existing skill (200)
    untouched instead of a 409 — agents retry, and a retry must not stack
    versions.
    """
    service = SkillService(db)
    skill, created = await service.get_or_create_skill(
        ctx.workspace.id, data, ctx.user.id
    )
    return JSONResponse(
        build_skill_read(skill).model_dump(mode="json"),
        status_code=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )


@router.post("/proposals")
async def propose_skill(
    data: SkillProposalCreate,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> JSONResponse:
    """Agent proposal path: a 'proposed' version + pending approval in one
    call. Member-gated, agent-caller required (the service raises the 403).

    Declared BEFORE the /{skill_slug} routes — a literal segment swallowed by
    the catch-all surfaces as a 405.
    """
    service = SkillService(db)
    proposal, created = await service.propose_skill(
        ctx.workspace.id, data, ctx.user.id
    )
    return JSONResponse(
        SkillProposalRead.model_validate(proposal).model_dump(mode="json"),
        status_code=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )


@router.get("/{skill_slug}", response_model=SkillRead)
async def get_skill(
    skill_slug: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> SkillRead:
    service = SkillService(db)
    return build_skill_read(
        await service.get_skill_detail(ctx.workspace.id, skill_slug)
    )


@router.post(
    "/{skill_slug}/archive",
    response_model=SkillRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def archive_skill(
    skill_slug: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> SkillRead:
    """Soft-archive: hides from the default listing, blocks new binds and
    proposals. Idempotent — re-archiving returns the skill unchanged."""
    service = SkillService(db)
    return build_skill_read(
        await service.archive_skill(ctx.workspace.id, skill_slug, ctx.user.id)
    )


@router.post(
    "/{skill_slug}/unarchive",
    response_model=SkillRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def unarchive_skill(
    skill_slug: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> SkillRead:
    service = SkillService(db)
    return build_skill_read(
        await service.unarchive_skill(ctx.workspace.id, skill_slug, ctx.user.id)
    )


@router.get(
    "/{skill_slug}/versions/{version}", response_model=SkillVersionDetailRead
)
async def get_skill_version(
    skill_slug: str,
    version: int,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> SkillVersionDetailRead:
    """The one place file contents are served — verbatim."""
    service = SkillService(db)
    return build_version_detail_read(
        await service.get_version(ctx.workspace.id, skill_slug, version)
    )


@router.post(
    "/{skill_slug}/versions",
    response_model=SkillVersionRead,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(forbid_agent_callers)],
)
async def create_skill_version(
    skill_slug: str,
    data: SkillVersionCreate,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> SkillVersionRead:
    service = SkillService(db)
    return build_version_read(
        await service.create_version(
            ctx.workspace.id,
            skill_slug,
            [f.model_dump() for f in data.files],
            ctx.user.id,
        )
    )


@router.post(
    "/{skill_slug}/versions/{version}/publish",
    response_model=SkillVersionRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def publish_skill_version(
    skill_slug: str,
    version: int,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> SkillVersionRead:
    service = SkillService(db)
    return build_version_read(
        await service.publish_version(
            ctx.workspace.id, skill_slug, version, ctx.user.id
        )
    )


@catalog_router.get("")
async def list_skill_catalog(
    ctx: WorkspaceContext = Depends(get_workspace),
) -> dict:
    return {
        "entries": [
            SkillCatalogEntryRead.model_validate(entry).model_dump()
            for entry in SKILL_CATALOG
        ]
    }


@catalog_router.post(
    "/{catalog_id}/activate", dependencies=[Depends(forbid_agent_callers)]
)
async def activate_catalog_skill(
    catalog_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db, scope="function"),
) -> JSONResponse:
    """Copy a catalog entry into the workspace as a published v1. Idempotent:
    re-activation returns the existing workspace copy (200) untouched."""
    service = SkillService(db)
    skill, created = await service.activate_catalog(
        ctx.workspace.id, catalog_id, ctx.user.id
    )
    return JSONResponse(
        build_skill_read(skill).model_dump(mode="json"),
        status_code=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
    )
