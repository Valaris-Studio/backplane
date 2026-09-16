# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select

from app.models.agents.prompt_config import AgentPromptConfig
from app.models.workspace import Workspace


class CompletionRoleRepository:
    def __init__(self, db):
        self.db = db

    async def prompt(self, workspace_id, role, stage, slug):
        return await self.db.scalar(
            select(AgentPromptConfig)
            .where(
                AgentPromptConfig.slug == slug,
                AgentPromptConfig.team_role == role,
                AgentPromptConfig.stage == stage,
                (AgentPromptConfig.workspace_id == workspace_id)
                | AgentPromptConfig.workspace_id.is_(None),
            )
            .order_by(
                AgentPromptConfig.workspace_id.is_(None).asc(),
                AgentPromptConfig.created_at.asc(),
                AgentPromptConfig.id.asc(),
            )
            .limit(1)
            .execution_options(populate_existing=True)
        )

    async def workspace_slug(self, workspace_id):
        return await self.db.scalar(
            select(Workspace.slug).where(Workspace.id == workspace_id)
        )
