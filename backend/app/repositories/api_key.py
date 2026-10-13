# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import delete, or_, select, update

from app.models.api_key import ApiKey
from app.models.companion import CompanionInstallation
from app.repositories.base import BaseRepository


class ApiKeyRepository(BaseRepository[ApiKey]):
    model = ApiKey

    async def stamp_last_used(
        self,
        key_id: uuid.UUID,
        used_at: datetime,
        *,
        older_than: datetime,
        expect_never_used: bool,
    ) -> bool:
        """Stamp a never-used or stale key; True only for the first-use winner.

        One conditional UPDATE: concurrent requests race in the database, not in
        Python. A row that another request already refreshed no longer matches,
        so it is neither overwritten with an older timestamp nor announced twice.
        The caller's loaded value says whether this request saw the key unused;
        RETURNING says whether this request's write is the one that landed.
        """
        stamped = await self.db.scalar(
            update(ApiKey)
            .where(
                ApiKey.id == key_id,
                or_(ApiKey.last_used_at.is_(None), ApiKey.last_used_at < older_than),
            )
            .values(last_used_at=used_at)
            .returning(ApiKey.id)
            .execution_options(synchronize_session=False)
        )
        return expect_never_used and stamped is not None

    async def get_by_key_hash(self, key_hash: str) -> ApiKey | None:
        result = await self.db.execute(
            select(ApiKey).where(ApiKey.key_hash == key_hash)
        )
        return result.scalar_one_or_none()

    async def installation_revoked(self, installation_id: uuid.UUID) -> bool:
        revoked_at = await self.db.scalar(
            select(CompanionInstallation.revoked_at).where(
                CompanionInstallation.id == installation_id
            )
        )
        return revoked_at is not None

    async def lock_installation(self, installation_id: uuid.UUID) -> None:
        """Serialize rotations of one installation's key (a no-op on SQLite)."""
        await self.db.execute(
            select(CompanionInstallation.id)
            .where(CompanionInstallation.id == installation_id)
            .with_for_update()
        )

    async def latest_for_installation(self, installation_id: uuid.UUID) -> ApiKey | None:
        result = await self.db.execute(
            select(ApiKey)
            .where(ApiKey.installation_id == installation_id)
            .order_by(ApiKey.created_at.desc())
            .limit(1)
        )
        return result.scalar_one_or_none()

    async def delete_for_installation(self, installation_id: uuid.UUID) -> None:
        await self.db.execute(
            delete(ApiKey)
            .where(ApiKey.installation_id == installation_id)
            .execution_options(synchronize_session="fetch")
        )

    async def list_by_user(self, user_id: uuid.UUID) -> list[ApiKey]:
        result = await self.db.execute(
            select(ApiKey)
            .where(ApiKey.user_id == user_id)
            .order_by(ApiKey.created_at.desc())
        )
        return list(result.scalars().all())
