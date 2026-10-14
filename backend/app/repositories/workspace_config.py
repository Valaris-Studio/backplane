# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import func, select

from app.models.workspace_config import WorkspaceConfig
from app.repositories.base import BaseRepository


class WorkspaceConfigRepository(BaseRepository[WorkspaceConfig]):
    model = WorkspaceConfig

    async def get_by_workspace(self, workspace_id: uuid.UUID) -> WorkspaceConfig | None:
        result = await self.db.execute(
            select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == workspace_id)
        )
        return result.scalar_one_or_none()

    async def lock_dispatch_policy(self, workspace_id: uuid.UUID, *, exclusive: bool) -> None:
        """Transaction-scoped lock serializing context-dispatch policy writes
        (exclusive) against scheduling polls and starts (shared).

        Always the FIRST lock a participating transaction takes, so every
        path orders policy lock -> hold -> workspace -> config. Not a shared
        workspace row lock: polls later take that row FOR UPDATE, and two
        polls upgrading SHARE -> UPDATE would deadlock each other. Shared
        holders never conflict. SQLite serializes writers already."""
        if self.db.get_bind().dialect.name != "postgresql":
            return
        lock = func.pg_advisory_xact_lock if exclusive else func.pg_advisory_xact_lock_shared
        await self.db.execute(
            select(lock(func.hashtextextended(f"context-dispatch-policy:{workspace_id}", 0)))
        )

    async def get_fresh(self, workspace_id: uuid.UUID) -> WorkspaceConfig | None:
        return await self.db.scalar(
            select(WorkspaceConfig)
            .where(WorkspaceConfig.workspace_id == workspace_id)
            .execution_options(populate_existing=True)
        )
