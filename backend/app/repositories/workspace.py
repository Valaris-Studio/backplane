# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.activity import Activity
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.base import BaseRepository


class WorkspaceRepository(BaseRepository[Workspace]):
    model = Workspace

    async def get_by_slug(self, slug: str) -> Workspace | None:
        result = await self.db.execute(select(Workspace).where(Workspace.slug == slug))
        return result.scalar_one_or_none()

    async def list_for_user_with_counts(
        self, user_id: uuid.UUID
    ) -> list[tuple[Workspace, int, int, datetime | None]]:
        """Return each of the user's workspaces alongside its board count, card
        count, and last-activity timestamp in ONE query — the welcome screen needs
        per-workspace stats and an N+1 (a call per workspace) would defeat the
        single-fetch list model.

        Correlated scalar subqueries (not double LEFT JOINs) keep the aggregates
        independent — joining boards AND cards in one statement would multiply
        rows and inflate board_count by the number of cards.

        last_activity_at is MAX(activities.created_at) for the workspace. Workspace
        .updated_at only moves on a workspace-row mutation (rename), so it does NOT
        reflect board/card edits — the real "recently active" signal lives in the
        activities log, which every mutation records. Backed by the
        ix_activities_workspace_created index. NULL when the workspace has no
        activity yet (the frontend falls back to updated_at).
        """
        board_count = (
            select(func.count(Board.id))
            .where(Board.workspace_id == Workspace.id)
            .correlate(Workspace)
            .scalar_subquery()
        )
        card_count = (
            select(func.count(Card.id))
            .select_from(Card)
            .join(Board, Card.board_id == Board.id)
            .where(Board.workspace_id == Workspace.id)
            .correlate(Workspace)
            .scalar_subquery()
        )
        last_activity_at = (
            select(func.max(Activity.created_at))
            .where(Activity.workspace_id == Workspace.id)
            .correlate(Workspace)
            .scalar_subquery()
        )
        result = await self.db.execute(
            select(Workspace, board_count, card_count, last_activity_at)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
            .where(WorkspaceMember.user_id == user_id)
            .order_by(Workspace.name)
        )
        return [(row[0], row[1], row[2], row[3]) for row in result.all()]


class WorkspaceMemberRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def add_member(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID, role: str = "member"
    ) -> WorkspaceMember:
        member = WorkspaceMember(workspace_id=workspace_id, user_id=user_id, role=role)
        self.db.add(member)
        await self.db.flush()
        return member

    async def get_membership(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> WorkspaceMember | None:
        result = await self.db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_membership_with_user(
        self, workspace_id: uuid.UUID, user_id: uuid.UUID
    ) -> WorkspaceMember | None:
        """get_membership plus the user relation, eager-loaded — the member
        schema reads email/name and WorkspaceMember.user is lazy="raise"."""
        result = await self.db.execute(
            select(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user_id,
            )
            .options(selectinload(WorkspaceMember.user))
        )
        return result.scalar_one_or_none()

    async def set_role(
        self, membership: WorkspaceMember, role: WorkspaceRole
    ) -> WorkspaceMember:
        membership.role = role
        await self.db.flush()
        return membership

    async def list_workspace_ids_for_user(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """Just the workspace ids the user belongs to — no member rows loaded.

        For fan-out callers that address a workspace and never read the
        membership itself (ApiKeyService's first-use publish).
        """
        result = await self.db.execute(
            select(WorkspaceMember.workspace_id).where(
                WorkspaceMember.user_id == user_id
            )
        )
        return list(result.scalars().all())

    async def lock_owner_memberships(self, workspace_id: uuid.UUID) -> None:
        """Row-lock the workspace's owner rows so a following count_owners can't
        go stale: under READ COMMITTED two concurrent demote/remove requests
        would each read owners=2 and both commit, orphaning the workspace with
        zero owners. FOR UPDATE serializes them, so the second one sees owners=1
        and its last-owner guard fires. SQLite ignores FOR UPDATE — harmless,
        and the tests never race."""
        await self.db.execute(
            select(WorkspaceMember.user_id)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.role == WorkspaceRole.owner,
            )
            .with_for_update()
        )

    async def count_owners(self, workspace_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count())
            .select_from(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.role == WorkspaceRole.owner,
            )
        )
        return result.scalar_one()

    async def list_members(self, workspace_id: uuid.UUID) -> list[WorkspaceMember]:
        result = await self.db.execute(
            select(WorkspaceMember)
            .where(WorkspaceMember.workspace_id == workspace_id)
            .options(selectinload(WorkspaceMember.user))
        )
        return list(result.scalars().all())

    async def search_members(
        self, workspace_id: uuid.UUID, q: str, limit: int = 10
    ) -> list[WorkspaceMember]:
        """Members whose user name OR email contains `q` (case-insensitive),
        capped at `limit` — the @mention autocomplete source (contract §6).
        Joins User for the filter; selectinload still eager-loads the relation
        so WorkspaceMember.user is greenlet-safe for the router's schema."""
        pattern = f"%{q}%"
        result = await self.db.execute(
            select(WorkspaceMember)
            .join(User, WorkspaceMember.user_id == User.id)
            .where(
                WorkspaceMember.workspace_id == workspace_id,
                or_(User.name.ilike(pattern), User.email.ilike(pattern)),
            )
            .options(selectinload(WorkspaceMember.user))
            .order_by(User.name, User.email)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def remove_member(self, workspace_id: uuid.UUID, user_id: uuid.UUID) -> None:
        member = await self.get_membership(workspace_id, user_id)
        if member:
            await self.db.delete(member)
            await self.db.flush()
