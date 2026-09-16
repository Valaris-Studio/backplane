# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import select, update

from app.models.api_key import ApiKey
from app.repositories.base import BaseRepository


class ApiKeyRepository(BaseRepository[ApiKey]):
    model = ApiKey

    async def claim_first_use(self, key_id: uuid.UUID, used_at: datetime) -> bool:
        """Stamp a never-used key, returning True only for the winning caller.

        The `last_used_at IS NULL` predicate makes never-used -> used a single
        atomic transition, so concurrent first requests race in the database
        rather than in Python: exactly one UPDATE matches a row, and its
        rowcount of 1 is what authorizes publishing API_KEY_FIRST_USED. A
        read-then-write would let both requests see NULL and double-publish.
        """
        result = await self.db.execute(
            update(ApiKey)
            .where(ApiKey.id == key_id, ApiKey.last_used_at.is_(None))
            .values(last_used_at=used_at)
        )
        return result.rowcount == 1

    async def refresh_last_used(
        self, key_id: uuid.UUID, used_at: datetime, *, older_than: datetime
    ) -> None:
        """Advance last_used_at only if it is still older than `older_than`.

        The bound repeats the caller's throttle decision as a WHERE clause so a
        concurrent request that already refreshed the row isn't overwritten with
        this request's (possibly older) timestamp.
        """
        await self.db.execute(
            update(ApiKey)
            .where(ApiKey.id == key_id, ApiKey.last_used_at < older_than)
            .values(last_used_at=used_at)
        )

    async def get_by_key_hash(self, key_hash: str) -> ApiKey | None:
        result = await self.db.execute(
            select(ApiKey).where(ApiKey.key_hash == key_hash)
        )
        return result.scalar_one_or_none()

    async def list_by_user(self, user_id: uuid.UUID) -> list[ApiKey]:
        result = await self.db.execute(
            select(ApiKey)
            .where(ApiKey.user_id == user_id)
            .order_by(ApiKey.created_at.desc())
        )
        return list(result.scalars().all())
