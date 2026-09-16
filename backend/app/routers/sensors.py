# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.agents.sensor import SensorManifestEntry
from app.services.agents.sensor import SensorCatalogService

router = APIRouter(prefix="/api/workspaces/{slug}/sensors", tags=["sensors"])


@router.get("", response_model=list[SensorManifestEntry])
async def list_sensors(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    """Return the union of sensor catalogs reported by agents in a workspace.

    Entries are deduplicated by name — the first agent to report a given sensor
    wins. Different workspaces may expose different sensors because agents are
    scoped per workspace (custom builds can add or remove sensors).
    """
    service = SensorCatalogService(db)
    return await service.list_for_workspace(ctx.workspace.slug)
