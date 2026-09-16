# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import CONFIG_CHANGED
from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.models.agents.agent import Agent
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.workspace_config import WorkspaceConfig
from app.repositories.agents.team import TeamRepository
from app.schemas.agents.agent import TeamMembershipInfo
from app.schemas.agents.team import TeamCreate, TeamMemberAdd, TeamUpdate
from app.services.pipeline_config_validation import canonicalize_pipeline_config
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
from app.utils import slugify

logger = logging.getLogger(__name__)


class TeamService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = TeamRepository(db)

    async def create_team(
        self,
        workspace_id: uuid.UUID,
        data: TeamCreate,
        user_id: uuid.UUID,
    ) -> tuple[AgentTeam, bool]:
        """Create a team. Returns (team, created). If `data.slug` is supplied
        and already taken in this workspace, returns the existing team with
        created=False (idempotent — see feedback_idempotent_mutations.md)."""
        if data.slug is not None:
            existing = await self.repo.get_by_slug(workspace_id, data.slug)
            if existing is not None:
                return existing, False
            slug = data.slug
        else:
            slug = await self._unique_slug_from_name(workspace_id, data.name)

        team = await self.repo.create(
            name=data.name,
            slug=slug,
            description=data.description,
            workspace_id=workspace_id,
            board_id=data.board_id,
            created_by_id=user_id,
        )
        return await self.repo.get_by_id_with_members(team.id), True

    async def _unique_slug_from_name(
        self, workspace_id: uuid.UUID, name: str
    ) -> str:
        base = slugify(name, fallback="team")
        candidate = base
        suffix = 2
        while await self.repo.slug_exists(workspace_id, candidate):
            candidate = f"{base}-{suffix}"
            suffix += 1
        return candidate

    async def get_team_by_identifier(
        self, identifier: str, workspace_id: uuid.UUID
    ) -> AgentTeam:
        """Resolve a team by UUID or slug, scoped to workspace."""
        try:
            team_uuid = uuid.UUID(identifier)
        except ValueError:
            team_uuid = None

        if team_uuid is not None:
            team = await self.repo.get_by_id_with_members(team_uuid)
            if team is not None and team.workspace_id == workspace_id:
                return team
            raise ResourceNotFoundError("Team not found")

        team = await self.repo.get_by_slug(workspace_id, identifier)
        if team is None:
            raise ResourceNotFoundError("Team not found")
        return team

    async def list_teams(
        self, workspace_id: uuid.UUID, include_inactive: bool = False
    ) -> list[AgentTeam]:
        return await self.repo.list_by_workspace(workspace_id, include_inactive)

    async def get_team(self, team_id: uuid.UUID) -> AgentTeam:
        team = await self.repo.get_by_id_with_members(team_id)
        if not team:
            raise ResourceNotFoundError("Team not found")
        return team

    async def update_team(self, team_id: uuid.UUID, data: TeamUpdate) -> AgentTeam:
        team = await self.repo.get_by_id(team_id)
        if not team:
            raise ResourceNotFoundError("Team not found")
        update_data = data.model_dump(exclude_unset=True)
        new_slug = update_data.get("slug")
        if new_slug is not None and new_slug != team.slug:
            if await self.repo.slug_exists(
                team.workspace_id, new_slug, exclude_id=team.id
            ):
                raise ConflictError(
                    f"Team slug '{new_slug}' already exists in this workspace"
                )
        await self.repo.update(team, **update_data)
        try:
            await event_bus.publish(
                event_type=CONFIG_CHANGED,
                payload={"entity": "team", "action": "updated", "entity_id": str(team_id)},
                workspace_id=team.workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish config.changed event")
        return await self.repo.get_by_id_with_members(team_id)

    async def deactivate_team(self, team_id: uuid.UUID) -> AgentTeam:
        team = await self.repo.get_by_id(team_id)
        if not team:
            raise ResourceNotFoundError("Team not found")
        await self.repo.update(team, is_active=False)
        return await self.repo.get_by_id_with_members(team_id)

    async def add_member(self, team_id: uuid.UUID, data: TeamMemberAdd) -> AgentTeamMember:
        team = await self.repo.get_by_id_with_members(team_id)
        if not team:
            raise ResourceNotFoundError("Team not found")

        # Verify agent exists
        result = await self.db.execute(select(Agent).where(Agent.id == data.agent_id))
        agent = result.scalar_one_or_none()
        if not agent:
            raise ResourceNotFoundError("Agent not found")

        unique_roles = await self._unique_roles_for_workspace(team.workspace_id)
        for role in data.roles:
            if role not in unique_roles:
                continue
            for m in team.members:
                if m.agent_id != data.agent_id and role in m.roles:
                    raise ValidationError(
                        f"Team already has a member with role '{role}'"
                    )

        # Idempotent: if agent already in team, update their roles
        existing = None
        for m in team.members:
            if m.agent_id == data.agent_id:
                existing = m
                break

        if existing:
            existing.roles = list(data.roles)
            await self.db.flush()
            return existing

        member = AgentTeamMember(
            team_id=team_id,
            agent_id=data.agent_id,
            roles=list(data.roles),
        )
        self.db.add(member)
        await self.db.flush()
        # Bust identity-map cache so next `get_by_id_with_members` sees the insert.
        await self.db.refresh(team, attribute_names=["members"])
        return member

    async def remove_member(self, team_id: uuid.UUID, agent_id: uuid.UUID) -> None:
        team = await self.repo.get_by_id_with_members(team_id)
        if not team:
            raise ResourceNotFoundError("Team not found")

        target = None
        for m in team.members:
            if m.agent_id == agent_id:
                target = m
                break
        if not target:
            raise ResourceNotFoundError("Member not found in team")

        await self.db.delete(target)
        await self.db.flush()
        await self.db.refresh(team, attribute_names=["members"])

    async def export_team(
        self, workspace_id: uuid.UUID, workspace_slug: str, team_slug: str
    ) -> dict:
        from app.models.kanban.board import Board
        from app.services.export.envelope import build_envelope

        team = await self.repo.get_by_slug(workspace_id, team_slug)
        if team is None:
            raise ResourceNotFoundError("Team not found")

        board_slug: str | None = None
        if team.board_id is not None:
            board_slug = await self.db.scalar(
                select(Board.slug).where(Board.id == team.board_id)
            )

        agent_ids = [m.agent_id for m in team.members]
        agents_by_id: dict[uuid.UUID, Agent] = {}
        if agent_ids:
            result = await self.db.execute(
                select(Agent).where(Agent.id.in_(agent_ids))
            )
            agents_by_id = {a.id: a for a in result.scalars().all()}

        members_data = []
        for member in team.members:
            agent = agents_by_id.get(member.agent_id)
            agent_name = agent.name if agent else "unknown"
            agent_slug = slugify(agent_name, fallback="agent") if agent else "unknown"
            members_data.append(
                {
                    "agent_slug": agent_slug,
                    "agent_name": agent_name,
                    "roles": list(member.roles),
                    "is_active": agent.is_active if agent else False,
                }
            )

        return build_envelope(
            entity_type="team",
            source_workspace_slug=workspace_slug,
            source_board_slug=board_slug,
            data={
                "slug": team.slug,
                "name": team.name,
                "description": team.description,
                "is_active": team.is_active,
                "board_slug": board_slug,
                "members": members_data,
            },
        )

    async def _load_pipeline_config(self, workspace_id: uuid.UUID) -> dict:
        """Return the workspace's pipeline_config with `unique` defaults filled in.

        Falls back to DEFAULT_PIPELINE_CONFIG when no row exists or the column
        is NULL (legacy workspaces that never called the config endpoint).
        The canonicalization step is idempotent and only adds missing keys.
        """
        result = await self.db.execute(
            select(WorkspaceConfig.pipeline_config).where(
                WorkspaceConfig.workspace_id == workspace_id
            )
        )
        raw = result.scalar_one_or_none()
        config = raw if isinstance(raw, dict) else DEFAULT_PIPELINE_CONFIG
        return canonicalize_pipeline_config(dict(config))

    async def _unique_roles_for_workspace(self, workspace_id: uuid.UUID) -> set[str]:
        config = await self._load_pipeline_config(workspace_id)
        stages = config.get("stages")
        if not isinstance(stages, list):
            return set()
        unique: set[str] = set()
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            role = stage.get("role")
            if isinstance(role, str) and role and bool(stage.get("unique")):
                unique.add(role)
        return unique

    async def pipeline_stage_roles(self, workspace_id: uuid.UUID) -> set[str]:
        """Set of role names declared in the workspace's pipeline_config.

        Used by the team-read enricher to compute `role_warnings` per member
        in a single batched fetch (no N+1)."""
        config = await self._load_pipeline_config(workspace_id)
        stages = config.get("stages")
        if not isinstance(stages, list):
            return set()
        roles: set[str] = set()
        for stage in stages:
            if not isinstance(stage, dict):
                continue
            role = stage.get("role")
            if isinstance(role, str) and role:
                roles.add(role)
        return roles

    async def get_agent_team_memberships(
        self, agent_id: uuid.UUID
    ) -> list[TeamMembershipInfo]:
        """Every active-team membership for an agent, newest first.

        `added_at` has a server_default, so memberships created in one
        transaction share a value — team_id breaks the tie and makes the order
        reproducible across calls.
        """
        stmt = (
            select(AgentTeamMember, AgentTeam)
            .join(AgentTeam, AgentTeamMember.team_id == AgentTeam.id)
            .where(AgentTeamMember.agent_id == agent_id)
            .where(AgentTeam.is_active.is_(True))
            .order_by(AgentTeamMember.added_at.desc(), AgentTeamMember.team_id.desc())
        )
        result = await self.db.execute(stmt)
        return [
            TeamMembershipInfo(team_id=team.id, team_name=team.name, roles=member.roles)
            for member, team in result.all()
        ]

    async def get_agent_team_info(self, agent_id: uuid.UUID) -> TeamMembershipInfo | None:
        """Return ONE membership for an agent — the most recently added.

        An agent on teams in several workspaces has no single "its" team, so
        callers that know which workspace they mean should scope by
        workspace_slug (see AgentService.get_agent_config) rather than rely on
        this. The ordering only guarantees the arbitrary pick is stable across
        calls; it does not make it correct.
        """
        stmt = (
            select(AgentTeamMember, AgentTeam)
            .join(AgentTeam, AgentTeamMember.team_id == AgentTeam.id)
            .where(AgentTeamMember.agent_id == agent_id)
            .where(AgentTeam.is_active.is_(True))
            .order_by(AgentTeamMember.added_at.desc(), AgentTeamMember.team_id.desc())
        )
        result = await self.db.execute(stmt)
        row = result.first()
        if not row:
            return None
        member, team = row
        return TeamMembershipInfo(
            team_id=team.id,
            team_name=team.name,
            roles=member.roles,
        )
