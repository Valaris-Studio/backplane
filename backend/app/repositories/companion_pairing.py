# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.companion_pairing import CompanionPairing, CompanionPairingLookupFailure


class CompanionPairingRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def user_code_hash_exists(self, user_code_hash: str) -> bool:
        return (
            await self.db.scalar(
                select(CompanionPairing.id).where(
                    CompanionPairing.user_code_hash == user_code_hash
                )
            )
        ) is not None

    async def add(self, pairing: CompanionPairing) -> CompanionPairing:
        self.db.add(pairing)
        await self.db.flush()
        return pairing

    async def by_device_code_hash(self, device_code_hash: str) -> CompanionPairing | None:
        return await self.db.scalar(
            select(CompanionPairing)
            .where(CompanionPairing.device_code_hash == device_code_hash)
            .execution_options(populate_existing=True)
        )

    async def by_user_code_hash(self, user_code_hash: str) -> CompanionPairing | None:
        return await self.db.scalar(
            select(CompanionPairing)
            .where(CompanionPairing.user_code_hash == user_code_hash)
            .execution_options(populate_existing=True)
        )

    async def get(self, pairing_id: uuid.UUID) -> CompanionPairing | None:
        return await self.db.get(CompanionPairing, pairing_id, populate_existing=True)

    async def claim_pending(
        self,
        pairing_id: uuid.UUID,
        decision: str,
        decided_by: uuid.UUID | None,
        decided_at: datetime | None = None,
    ) -> bool:
        """Move pending → decision atomically; only one concurrent decision wins."""
        result = await self.db.execute(
            update(CompanionPairing)
            .where(CompanionPairing.id == pairing_id, CompanionPairing.state == "pending")
            .values(state=decision, approved_by=decided_by, approved_at=decided_at)
            .execution_options(synchronize_session=False)
        )
        return result.rowcount == 1

    async def claim_approved(self, pairing_id: uuid.UUID) -> bool:
        """Move approved → consumed atomically; only one concurrent poll wins."""
        result = await self.db.execute(
            update(CompanionPairing)
            .where(CompanionPairing.id == pairing_id, CompanionPairing.state == "approved")
            .values(state="consumed")
            .execution_options(synchronize_session=False)
        )
        return result.rowcount == 1

    async def record_lookup_failure(self, user_id: uuid.UUID, now: datetime) -> None:
        self.db.add(CompanionPairingLookupFailure(user_id=user_id, created_at=now))
        await self.db.flush()

    async def recent_lookup_failures(self, user_id: uuid.UUID, since: datetime) -> int:
        # Older rows can never count again, so they are dropped on the way.
        await self.db.execute(
            delete(CompanionPairingLookupFailure).where(
                CompanionPairingLookupFailure.user_id == user_id,
                CompanionPairingLookupFailure.created_at < since,
            )
        )
        return await self.db.scalar(
            select(func.count())
            .select_from(CompanionPairingLookupFailure)
            .where(
                CompanionPairingLookupFailure.user_id == user_id,
                CompanionPairingLookupFailure.created_at >= since,
            )
        )

    async def delete_expired_before(self, cutoff: datetime, limit: int) -> int:
        """Deletes at most `limit` pairings that expired before `cutoff`, in any
        state; returns how many it deleted."""
        expired = list(
            await self.db.scalars(
                select(CompanionPairing.id)
                .where(CompanionPairing.expires_at < cutoff)
                .limit(limit)
            )
        )
        if expired:
            await self.db.execute(
                delete(CompanionPairing)
                .where(CompanionPairing.id.in_(expired))
                .execution_options(synchronize_session=False)
            )
        return len(expired)
