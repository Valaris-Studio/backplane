# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select

from app.models.agents.agent import Agent
from app.repositories.base import BaseRepository


class AgentRepository(BaseRepository[Agent]):
    model = Agent

    async def list_by_owner(
        self, user_id: uuid.UUID, include_inactive: bool = False
    ) -> list[Agent]:
        query = select(Agent).where(Agent.created_by_id == user_id)
        if not include_inactive:
            query = query.where(Agent.is_active.is_(True))
        query = query.order_by(Agent.created_at.desc())
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_by_owner_and_name(
        self, user_id: uuid.UUID, name: str
    ) -> Agent | None:
        result = await self.db.execute(
            select(Agent).where(
                Agent.created_by_id == user_id,
                Agent.name == name,
            )
        )
        return result.scalar_one_or_none()

    async def get_by_owner_and_id(
        self, user_id: uuid.UUID, agent_id: uuid.UUID
    ) -> Agent | None:
        result = await self.db.execute(
            select(Agent).where(
                Agent.created_by_id == user_id,
                Agent.id == agent_id,
            )
        )
        return result.scalar_one_or_none()
