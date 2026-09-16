# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from collections.abc import Iterable

from sqlalchemy import select

from app.models.notifications.preference import NotificationPreference
from app.repositories.base import BaseRepository


class NotificationPreferenceRepository(BaseRepository[NotificationPreference]):
    model = NotificationPreference

    async def get_for(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID
    ) -> NotificationPreference | None:
        result = await self.db.execute(
            select(NotificationPreference).where(
                NotificationPreference.user_id == user_id,
                NotificationPreference.workspace_id == workspace_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_for_users(
        self, user_ids: Iterable[uuid.UUID], workspace_id: uuid.UUID
    ) -> dict[uuid.UUID, NotificationPreference]:
        """Batch-load prefs for a fan-out's recipient set in ONE query (kills the
        per-recipient N+1 in generation). Users with no row are simply absent
        from the dict; the caller defaults them (a missing row = all defaults)."""
        ids = list(user_ids)
        if not ids:
            return {}
        result = await self.db.execute(
            select(NotificationPreference).where(
                NotificationPreference.user_id.in_(ids),
                NotificationPreference.workspace_id == workspace_id,
            )
        )
        return {row.user_id: row for row in result.scalars().all()}

    async def upsert(
        self, user_id: uuid.UUID, workspace_id: uuid.UUID, **fields
    ) -> NotificationPreference:
        existing = await self.get_for(user_id, workspace_id)
        if existing is not None:
            return await self.update(existing, **fields)
        return await self.create(user_id=user_id, workspace_id=workspace_id, **fields)
