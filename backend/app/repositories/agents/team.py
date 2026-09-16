# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.models.agents.agent import Agent
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.repositories.base import BaseRepository


class TeamRepository(BaseRepository[AgentTeam]):
    model = AgentTeam

    async def list_active_workspace_ids_for_agent(
        self, agent_id: uuid.UUID
    ) -> list[uuid.UUID]:
        result = await self.db.execute(
            select(AgentTeam.workspace_id)
            .join(AgentTeamMember, AgentTeamMember.team_id == AgentTeam.id)
            .where(
                AgentTeamMember.agent_id == agent_id,
                AgentTeam.is_active.is_(True),
            )
        )
        return list(result.scalars())

    async def list_bound_agents_by_board(self, board_id: uuid.UUID) -> list[Agent]:
        """Agents bound to a board via team membership (AgentTeam.board_id) —
        the ONLY binding that counts for loop status; health_current_board_id
        is an agent passing through, not a binding. An agent on two teams bound
        to the same board is still one agent: the IN-subquery dedupes inherently.
        Never DISTINCT over the Agent entity — its json columns have no equality
        operator on Postgres (UndefinedFunctionError), and SQLite tests can't
        catch that."""
        result = await self.db.execute(
            select(Agent).where(
                Agent.id.in_(
                    select(AgentTeamMember.agent_id)
                    .join(AgentTeam, AgentTeam.id == AgentTeamMember.team_id)
                    .where(
                        AgentTeam.board_id == board_id,
                        AgentTeam.is_active.is_(True),
                    )
                )
            )
        )
        return list(result.scalars().all())

    async def list_by_workspace(
        self, workspace_id: uuid.UUID, include_inactive: bool = False
    ) -> list[AgentTeam]:
        stmt = select(AgentTeam).where(AgentTeam.workspace_id == workspace_id)
        if not include_inactive:
            stmt = stmt.where(AgentTeam.is_active.is_(True))
        stmt = stmt.options(selectinload(AgentTeam.members))
        stmt = stmt.order_by(AgentTeam.created_at.desc())
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def get_by_id_with_members(self, team_id: uuid.UUID) -> AgentTeam | None:
        stmt = (
            select(AgentTeam)
            .where(AgentTeam.id == team_id)
            .options(selectinload(AgentTeam.members))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def get_by_slug(self, workspace_id: uuid.UUID, slug: str) -> AgentTeam | None:
        stmt = (
            select(AgentTeam)
            .where(AgentTeam.workspace_id == workspace_id)
            .where(AgentTeam.slug == slug)
            .options(selectinload(AgentTeam.members))
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def slug_exists(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        exclude_id: uuid.UUID | None = None,
    ) -> bool:
        stmt = (
            select(AgentTeam.id)
            .where(AgentTeam.workspace_id == workspace_id)
            .where(AgentTeam.slug == slug)
        )
        if exclude_id is not None:
            stmt = stmt.where(AgentTeam.id != exclude_id)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none() is not None
