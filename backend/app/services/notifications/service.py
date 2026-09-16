# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase 3 — Notification HTTP API service.

Owns the business logic + authorization for the current-user-scoped notification
endpoints (contract §"API surface"): the owner-only read guard, the optional
`?workspace=<slug>` resolution-with-membership-check, and building the effective
preference map from the Phase-2 resolver. Routers stay thin (parse → call →
schema); repositories stay pure data access.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.notifications.notification import Notification
from app.repositories.notifications.notification import NotificationRepository
from app.repositories.notifications.preference import NotificationPreferenceRepository
from app.repositories.workspace import WorkspaceMemberRepository, WorkspaceRepository
from app.services.notifications.channels import CHANNEL_REGISTRY
from app.services.notifications.preferences import CATEGORY_DEFAULTS, PreferenceResolver


class NotificationApiService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.notif_repo = NotificationRepository(db)
        self.pref_repo = NotificationPreferenceRepository(db)
        self.workspace_repo = WorkspaceRepository(db)
        self.member_repo = WorkspaceMemberRepository(db)
        self.resolver = PreferenceResolver()

    async def resolve_workspace_id(
        self, user_id: uuid.UUID, slug: str | None
    ) -> uuid.UUID | None:
        """Resolve an optional `?workspace=<slug>` filter to a workspace id and
        re-verify membership (contract: "membership is re-verified when
        ?workspace= is supplied"). Omitted slug = cross-workspace rollup (None).
        404 for an unknown slug OR a workspace the user isn't a member of — the
        same status, so non-membership never leaks a workspace's existence."""
        if slug is None:
            return None
        workspace = await self.workspace_repo.get_by_slug(slug)
        if workspace is None:
            raise ResourceNotFoundError(f"Workspace '{slug}' not found")
        membership = await self.member_repo.get_membership(workspace.id, user_id)
        if membership is None:
            raise ResourceNotFoundError(f"Workspace '{slug}' not found")
        return workspace.id

    async def list_for_user(
        self,
        user_id: uuid.UUID,
        *,
        workspace_id: uuid.UUID | None,
        limit: int,
        before: datetime | None,
        unread_only: bool,
    ) -> list[Notification]:
        return await self.notif_repo.list_for_recipient(
            user_id,
            workspace_id=workspace_id,
            limit=limit,
            before=before,
            unread_only=unread_only,
        )

    async def unread_count(
        self, user_id: uuid.UUID, *, workspace_id: uuid.UUID | None
    ) -> int:
        return await self.notif_repo.unread_count(user_id, workspace_id=workspace_id)

    async def mark_read(
        self, user_id: uuid.UUID, notification_id: uuid.UUID
    ) -> Notification:
        """Owner-only (INV: no row leaks/mutates across users). A non-owner —
        whether the row belongs to someone else or doesn't exist — gets 404, so
        the guard never reveals another user's notification exists."""
        notification = await self.notif_repo.get_by_id(notification_id)
        if notification is None or notification.recipient_user_id != user_id:
            raise ResourceNotFoundError("Notification not found")
        return await self.notif_repo.mark_read(notification)

    async def mark_all_read(
        self, user_id: uuid.UUID, *, workspace_id: uuid.UUID | None
    ) -> None:
        await self.notif_repo.mark_all_read(user_id, workspace_id=workspace_id)

    async def get_preferences(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> dict:
        """Return raw prefs + the effective (category × channel) map. A user with
        no row gets the defaults (relevance_scope=watching, no overrides, not
        muted) plus the effective map those defaults imply."""
        row = await self.pref_repo.get_for(user_id, workspace_id)
        eff = self.resolver.resolve(row)
        return {
            "relevance_scope": eff.relevance_scope,
            "category_overrides": eff.category_overrides,
            "muted": eff.muted,
            "effective": self._effective_map(eff),
        }

    async def put_preferences(
        self,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        *,
        relevance_scope: str | None,
        category_overrides: dict | None,
        muted: bool | None,
    ) -> dict:
        """Upsert prefs (lazy row creation) then return the same shape as GET so
        the caller round-trips the resolved effective map. Only supplied fields
        are written — an omitted field keeps its stored/default value."""
        fields: dict = {}
        if relevance_scope is not None:
            fields["relevance_scope"] = relevance_scope
        if category_overrides is not None:
            fields["category_overrides"] = category_overrides
        if muted is not None:
            fields["muted"] = muted
        await self.pref_repo.upsert(user_id, workspace_id, **fields)
        return await self.get_preferences(user_id, workspace_id)

    def list_channels(self) -> list[str]:
        return list(CHANNEL_REGISTRY.keys())

    @staticmethod
    def _effective_map(eff) -> dict[str, dict[str, bool]]:
        """Total map over every known category × every registered channel — the
        data-driven grid the FE renders (a new category or channel needs no FE
        change). Each cell runs the same precedence as generation
        (muted → override → category default by relevance_scope)."""
        channel_keys = list(CHANNEL_REGISTRY.keys())
        return {
            category: {
                channel: eff.channel_enabled(category, channel)
                for channel in channel_keys
            }
            for category in CATEGORY_DEFAULTS
        }
