# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select

from app.models.agents.tool_invocation import ToolInvocation
from app.repositories.base import BaseRepository


class ToolInvocationRepository(BaseRepository[ToolInvocation]):
    model = ToolInvocation

    async def bulk_create(self, execution_id: uuid.UUID, invocations: list[dict]) -> list[ToolInvocation]:
        instances = []
        for inv in invocations:
            instance = ToolInvocation(execution_id=execution_id, **inv)
            self.db.add(instance)
            instances.append(instance)
        await self.db.flush()
        return instances

    async def list_by_execution(self, execution_id: uuid.UUID) -> list[ToolInvocation]:
        result = await self.db.execute(
            select(ToolInvocation)
            .where(ToolInvocation.execution_id == execution_id)
            .order_by(ToolInvocation.position)
        )
        return list(result.scalars().all())
