# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent


class SensorCatalogRepository:
    """Pure data-access for sensor catalogs stored on agents.

    Agents persist their reported sensor catalog as JSON on the Agent row; this
    repo fetches the raw lists. Filtering/deduplication is service-layer work.
    """

    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_catalogs_for_workspace(self, workspace_slug: str) -> list[list[dict]]:
        """Return the sensor_catalog JSON from every active agent in the workspace.

        Agents store their allowed workspaces as a JSON list of slugs; we filter
        in Python because SQLite (tests) lacks a portable JSON contains operator.
        """
        result = await self.db.execute(
            select(Agent.allowed_workspaces, Agent.sensor_catalog).where(
                Agent.is_active.is_(True),
                Agent.sensor_catalog.is_not(None),
            )
        )
        catalogs: list[list[dict]] = []
        for allowed_workspaces, sensor_catalog in result.all():
            if not sensor_catalog:
                continue
            if not allowed_workspaces or workspace_slug not in allowed_workspaces:
                continue
            catalogs.append(sensor_catalog)
        return catalogs
