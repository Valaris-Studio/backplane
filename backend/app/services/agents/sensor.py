# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.agents.sensor import SensorCatalogRepository
from app.schemas.agents.sensor import SensorManifestEntry


class SensorCatalogService:
    """Aggregates sensor manifests reported by agents in a workspace.

    Scoping is workspace-level because different agents (possibly custom builds)
    may support different sensors. Deduplication runs inside the service so the
    repository stays a pure data-access layer.
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = SensorCatalogRepository(db)

    async def list_for_workspace(self, workspace_slug: str) -> list[SensorManifestEntry]:
        catalogs = await self.repo.list_catalogs_for_workspace(workspace_slug)

        # First-agent-wins dedup: the reported manifest for a given sensor name
        # is kept once. Catalogs are already filtered to non-empty lists by the repo.
        seen: dict[str, SensorManifestEntry] = {}
        for catalog in catalogs:
            for entry in catalog:
                name = entry.get("name")
                if not name or name in seen:
                    continue
                seen[name] = SensorManifestEntry(
                    name=name,
                    kind=entry.get("kind", ""),
                    default_config=entry.get("default_config", {}) or {},
                    config_schema=entry.get("config_schema"),
                    description=entry.get("description"),
                )

        return sorted(seen.values(), key=lambda e: e.name)
