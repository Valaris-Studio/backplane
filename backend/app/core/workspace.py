# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from dataclasses import dataclass

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id, get_current_user
from app.core.cache import workspace_slug_cache
from app.database import get_db
from app.exceptions import ForbiddenError, ResourceNotFoundError
from app.models.agents.agent import Agent
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


@dataclass
class WorkspaceContext:
    workspace: Workspace
    membership: WorkspaceMember
    user: User


async def _enforce_agent_workspace_scope(slug: str, db: AsyncSession) -> None:
    """Hold an agent API key to the workspaces its agent is scoped to.

    Membership alone does not contain an agent: the key resolves to its creating
    user, so an agent inherits every workspace that user belongs to and
    `allowed_workspaces` is decorative. Enforced here rather than per-route
    because this dependency is the one gate every workspace-scoped path shares.

    Reads are held to the same line as writes — a scope that still exposes
    another workspace's boards, cards and notes is not a scope.

    A null or empty allowlist stays unrestricted. New agents cannot have one
    (the create/update schemas reject it), so this is only reached by rows
    predating that rule, and denying them would strand every legacy runner.
    """
    await enforce_agent_scope(current_agent_id.get(), slug, db)


async def enforce_agent_scope(
    agent_id: uuid.UUID | None, slug: str, db: AsyncSession
) -> None:
    """The scope predicate itself, for callers that hold the agent id directly.

    The WebSocket path authenticates outside the HTTP dependency graph and never
    sets the ContextVar, and file storage resolves its workspace from a path
    segment rather than a route parameter — so both need the rule without the
    ambient lookup. One definition, because three copies of a security predicate
    drift and the divergence is invisible until someone exploits it.
    """
    if agent_id is None:
        return

    allowed = (
        await db.execute(select(Agent.allowed_workspaces).where(Agent.id == agent_id))
    ).scalar_one_or_none()
    if not allowed:
        return

    if slug not in allowed:
        raise ForbiddenError(
            f"Agent is not scoped to workspace '{slug}' (allowed: {', '.join(allowed)})"
        )


class WorkspaceDep:
    """Dependency that resolves workspace from slug and verifies membership."""

    def __init__(self, min_role: WorkspaceRole | None = None):
        self.min_role = min_role

    async def __call__(
        self,
        slug: str,
        user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> WorkspaceContext:
        await _enforce_agent_workspace_scope(slug, db)

        workspace = await self._resolve_workspace(slug, db)
        if not workspace:
            raise ResourceNotFoundError(f"Workspace '{slug}' not found")

        result = await db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.user_id == user.id,
            )
        )
        membership = result.scalar_one_or_none()
        if not membership:
            raise ForbiddenError("Not a member of this workspace")

        if self.min_role:
            role_hierarchy = {
                WorkspaceRole.owner: 0,
                WorkspaceRole.admin: 1,
                WorkspaceRole.member: 2,
                WorkspaceRole.viewer: 3,
            }
            if role_hierarchy[membership.role] > role_hierarchy[self.min_role]:
                raise ForbiddenError("Insufficient permissions")

        return WorkspaceContext(workspace=workspace, membership=membership, user=user)

    async def _resolve_workspace(self, slug: str, db: AsyncSession) -> Workspace | None:
        """Slug → workspace, through the Tier-1 cache when it is enabled.

        Only the slug→id hop is cached (docs/caching-policy.md): the membership
        and role reads below it stay on the database every request, because a
        stale role is a security boundary violation.

        A cached id is re-loaded by primary key rather than trusted blindly — a
        workspace delete emits no activity event, so nothing evicts on delete and
        the id-load is what turns a vanished workspace into a miss instead of a
        resurrection. Both the miss and the stale-id path fall back to the slug
        query, so behaviour is identical with the cache off.
        """
        cached_id = workspace_slug_cache.lookup(slug)
        if cached_id is not None:
            workspace = await db.get(Workspace, cached_id)
            if workspace is not None and workspace.slug == slug:
                return workspace
            workspace_slug_cache.forget(slug)

        result = await db.execute(select(Workspace).where(Workspace.slug == slug))
        workspace = result.scalar_one_or_none()
        if workspace is not None:
            workspace_slug_cache.remember(slug, workspace.id)
        return workspace


get_workspace = WorkspaceDep()
get_workspace_member = WorkspaceDep(min_role=WorkspaceRole.member)
get_workspace_admin = WorkspaceDep(min_role=WorkspaceRole.admin)
get_workspace_owner = WorkspaceDep(min_role=WorkspaceRole.owner)


async def resolve_board_id(
    board_id: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
) -> uuid.UUID:
    """Resolve `{board_id}` path param (UUID or slug) to the board's UUID.

    Also verifies the board belongs to the workspace in the URL, so child
    routers no longer need a separate workspace-scope check.
    """
    try:
        board_uuid = uuid.UUID(board_id)
    except ValueError:
        board_uuid = None

    if board_uuid is not None:
        result = await db.execute(
            select(Board.id).where(
                Board.id == board_uuid, Board.workspace_id == ctx.workspace.id
            )
        )
        resolved = result.scalar_one_or_none()
    else:
        result = await db.execute(
            select(Board.id).where(
                Board.slug == board_id, Board.workspace_id == ctx.workspace.id
            )
        )
        resolved = result.scalar_one_or_none()

    if resolved is None:
        raise ResourceNotFoundError("Board not found")
    return resolved
