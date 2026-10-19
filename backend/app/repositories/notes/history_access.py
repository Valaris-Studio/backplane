# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select

from app.models.agents.agent import Agent
from app.models.api_key import ApiKey
from app.models.companion import CompanionInstallation
from app.models.mcp_invocation import MCPInvocation
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember


class NoteHistoryAccessRepository:
    """Fresh scalar facts: never load credentials or cached ORM authorization."""

    def __init__(self, db):
        self.db = db

    async def membership(self, workspace_id, user_id):
        return (await self.db.execute(select(WorkspaceMember.role, Workspace.slug)
            .join(Workspace, Workspace.id == WorkspaceMember.workspace_id)
            .where(WorkspaceMember.workspace_id == workspace_id,
                   WorkspaceMember.user_id == user_id))).first()

    async def user_name(self, user_id):
        return await self.db.scalar(select(User.name).where(User.id == user_id))

    async def key(self, key_id):
        return (await self.db.execute(select(ApiKey.user_id, ApiKey.name, ApiKey.installation_id)
            .where(ApiKey.id == key_id))).first()

    async def agent(self, agent_id):
        return (await self.db.execute(select(Agent.name, Agent.is_active, Agent.allowed_workspaces, Agent.api_key_id)
            .where(Agent.id == agent_id))).first()

    async def installation(self, installation_id):
        return (await self.db.execute(select(CompanionInstallation.owner_id, CompanionInstallation.revoked_at)
            .where(CompanionInstallation.id == installation_id))).first()

    async def outcomes(self, invocation_ids):
        if not invocation_ids:
            return {}
        rows = (await self.db.execute(select(
            MCPInvocation.id, MCPInvocation.owner_id, MCPInvocation.agent_id,
            MCPInvocation.workspace_id, MCPInvocation.scope_status,
            MCPInvocation.tool_name, MCPInvocation.status,
        ).where(MCPInvocation.id.in_(invocation_ids)))).all()
        return {row.id: row for row in rows}
