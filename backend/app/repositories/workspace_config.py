# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select

from app.models.workspace_config import WorkspaceConfig
from app.repositories.base import BaseRepository


class WorkspaceConfigRepository(BaseRepository[WorkspaceConfig]):
    model = WorkspaceConfig

    async def get_by_workspace(self, workspace_id: uuid.UUID) -> WorkspaceConfig | None:
        result = await self.db.execute(
            select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == workspace_id)
        )
        return result.scalar_one_or_none()
