# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select, union_all

from app.models.agents.prompt_config import AgentPromptConfig
from app.models.kanban.board import Board
from app.models.workspace_config import WorkspaceConfig
from app.repositories.base import BaseRepository


class PromptConfigRepository(BaseRepository[AgentPromptConfig]):
    model = AgentPromptConfig

    async def completion_policy_values(self, workspace_id: uuid.UUID | None):
        board_policies = select(Board.completion_policy).where(
            Board.completion_policy.is_not(None)
        )
        workspace_policies = select(WorkspaceConfig.completion_policy).where(
            WorkspaceConfig.completion_policy.is_not(None)
        )
        if workspace_id is not None:
            board_policies = board_policies.where(Board.workspace_id == workspace_id)
            workspace_policies = workspace_policies.where(
                WorkspaceConfig.workspace_id == workspace_id
            )
        result = await self.db.scalars(union_all(board_policies, workspace_policies))
        return list(result.all())

    async def get_by_slug(
        self,
        workspace_id: uuid.UUID,
        slug: str,
    ) -> AgentPromptConfig | None:
        """Resolve a prompt config by slug, workspace-scoped.

        Multiple rows can share a slug within a workspace (the composite
        unique is `(workspace, team, team_role, stage, slug)`, not just
        slug). We prefer the workspace-scoped row over a system-scoped
        fallback so operator overrides win; among workspace rows we pick
        the oldest deterministically. This mirrors `list_by_workspace`'s
        slug-ordered read.
        """
        stmt = (
            select(AgentPromptConfig)
            .where(
                AgentPromptConfig.slug == slug,
                (AgentPromptConfig.workspace_id == workspace_id)
                | (AgentPromptConfig.workspace_id.is_(None)),
            )
            # NULLS LAST via is-not-null DESC: workspace-scoped rows first,
            # then oldest-first as a stable tiebreaker.
            .order_by(
                AgentPromptConfig.workspace_id.is_(None).asc(),
                AgentPromptConfig.created_at.asc(),
            )
        )
        result = await self.db.execute(stmt)
        return result.scalars().first()

    async def list_by_workspace(
        self,
        workspace_id: uuid.UUID | None = None,
        team_role: str | None = None,
    ) -> list[AgentPromptConfig]:
        stmt = select(AgentPromptConfig)
        if workspace_id:
            # Return configs scoped to this workspace plus system-level (workspace_id=NULL)
            stmt = stmt.where(
                (AgentPromptConfig.workspace_id == workspace_id)
                | (AgentPromptConfig.workspace_id.is_(None))
            )
        else:
            stmt = stmt.where(AgentPromptConfig.workspace_id.is_(None))
        if team_role:
            stmt = stmt.where(AgentPromptConfig.team_role == team_role)
        result = await self.db.execute(stmt.order_by(AgentPromptConfig.slug))
        return list(result.scalars().all())

    async def get_by_scope_slug(
        self,
        workspace_id: uuid.UUID | None,
        team_id: uuid.UUID | None,
        team_role: str | None,
        stage: str,
        slug: str,
    ) -> AgentPromptConfig | None:
        stmt = select(AgentPromptConfig).where(
            AgentPromptConfig.stage == stage,
            AgentPromptConfig.slug == slug,
        )
        stmt = stmt.where(
            AgentPromptConfig.workspace_id == workspace_id
            if workspace_id is not None
            else AgentPromptConfig.workspace_id.is_(None)
        )
        stmt = stmt.where(
            AgentPromptConfig.team_id == team_id
            if team_id is not None
            else AgentPromptConfig.team_id.is_(None)
        )
        stmt = stmt.where(
            AgentPromptConfig.team_role == team_role
            if team_role is not None
            else AgentPromptConfig.team_role.is_(None)
        )
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()
