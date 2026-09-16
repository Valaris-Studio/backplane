# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.repositories.agents.tool_invocation import ToolInvocationRepository
from app.schemas.agents.execution import ToolInvocationCreate
from app.services.agents.identity import verify_caller_owns_agent


def _as_naive_utc(value: datetime | None) -> datetime | None:
    # MCP tracker sends tz-aware UTC iso strings; the tool_invocations columns
    # are TIMESTAMP WITHOUT TIME ZONE (consistent with the rest of the
    # codebase). asyncpg rejects tz-aware values against that column type on
    # Postgres, producing 500s and leaving executions with empty invocation
    # lists. Normalize to naive UTC here so both asyncpg and aiosqlite accept
    # the write without losing the instant.
    if value is None or value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


class ToolInvocationService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ToolInvocationRepository(db)

    async def _get_execution(
        self,
        agent_id: uuid.UUID,
        execution_id: uuid.UUID,
        user_id: uuid.UUID | None = None,
    ) -> AgentExecution:
        result = await self.db.execute(
            select(AgentExecution).where(
                AgentExecution.id == execution_id,
                AgentExecution.agent_id == agent_id,
            )
        )
        execution = result.scalar_one_or_none()
        if not execution:
            raise ResourceNotFoundError("Execution not found")
        agent_row = await self.db.execute(select(Agent).where(Agent.id == agent_id))
        agent = agent_row.scalar_one_or_none()
        if not agent:
            raise ResourceNotFoundError("Execution not found")
        verify_caller_owns_agent(
            agent,
            actor_id=user_id,
            foreign_user_error=lambda: ResourceNotFoundError("Execution not found"),
        )
        return execution

    async def record_invocations(
        self,
        agent_id: uuid.UUID,
        execution_id: uuid.UUID,
        invocations: list[ToolInvocationCreate],
        user_id: uuid.UUID | None = None,
    ):
        await self._get_execution(agent_id, execution_id, user_id)
        inv_dicts = []
        for inv in invocations:
            data = inv.model_dump(exclude_unset=False)
            data["started_at"] = _as_naive_utc(data.get("started_at"))
            data["completed_at"] = _as_naive_utc(data.get("completed_at"))
            inv_dicts.append(data)
        return await self.repo.bulk_create(execution_id, inv_dicts)
