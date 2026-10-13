# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select

from app.models.agents.agent import Agent
from app.models.mcp_invocation import MCPConsultation, MCPInvocation
from app.models.workspace import Workspace, WorkspaceMember
from app.repositories.dialect_insert import conflict_aware_insert


class MCPInvocationRepository:
    def __init__(self, db):
        self.db = db

    async def get(self, invocation_id, owner_id, agent_id):
        return await self.db.scalar(
            select(MCPInvocation).where(
                MCPInvocation.id == invocation_id,
                MCPInvocation.owner_id == owner_id,
                MCPInvocation.agent_id == agent_id,
            )
        )

    async def workspace(self, owner_id, *, slug=None, workspace_id=None):
        query = (
            select(Workspace)
            .join(WorkspaceMember)
            .where(WorkspaceMember.user_id == owner_id)
        )
        query = (
            query.where(Workspace.id == workspace_id)
            if workspace_id
            else query.where(Workspace.slug == slug)
        )
        return await self.db.scalar(query)

    async def agent(self, agent_id):
        return await self.db.get(Agent, agent_id, populate_existing=True)

    async def insert(self, values):
        return await self.db.scalar(
            conflict_aware_insert(self.db, MCPInvocation)
            .values(**values)
            .on_conflict_do_nothing(index_elements=["id"])
            .returning(MCPInvocation.id)
        )

    async def record_consultation(self, values):
        await self.db.execute(
            conflict_aware_insert(self.db, MCPConsultation)
            .values(**values)
            .on_conflict_do_nothing()
        )
