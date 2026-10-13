# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.config import settings
from app.repositories.agent_session import AgentSessionRepository
from app.repositories.companion_pairing import CompanionPairingRepository
from app.services.session_content_cleanup import SessionContentCleanup
from app.services.session_history_cutoff import history_cutoffs
from app.services.storage.session_content import content_store

logger = logging.getLogger(__name__)

PURGE_BATCH_SIZE = 500
MAX_PURGE_BATCHES = 20
# PostgreSQL advisory lock taken per batch transaction: while one worker is
# purging, the others skip their tick. Transaction-scoped on purpose, so the
# lock can never ride a pooled connection back into an unrelated request.
PURGE_LOCK_KEY = 0x5E551011
# A pairing that just expired still answers "expired" to a late poll or browser
# lookup; only rows past this grace are deleted.
PAIRING_SWEEP_GRACE = timedelta(days=1)


class SessionRetentionService:
    """Deletes sessions past their device's `retention_days`, leaving
    tombstones, clears revoked devices' tombstones and links to deleted work,
    sweeps expired pairing requests (started without credentials, so nothing
    else ever removes them), and cleans up session content (see
    SessionContentCleanup). Does nothing while COMPANION_ENABLED is off.

    A background job: each batch owns its session and transaction (only
    `get_db` auto-commits), so a failure loses one batch, never a whole pass.
    """

    def __init__(self, session_factory: async_sessionmaker):
        self.session_factory = session_factory

    async def run_purge(
        self,
        batch_size: int = PURGE_BATCH_SIZE,
        max_batches: int = MAX_PURGE_BATCHES,
    ) -> int:
        if not settings.COMPANION_ENABLED:
            return 0
        deleted = 0
        for _ in range(max_batches):
            now = datetime.now(timezone.utc)
            async with self.session_factory() as db:
                async with db.begin():
                    if not await self._claim(db):
                        return deleted
                    repo = AgentSessionRepository(db)
                    expired = await repo.sessions_past_retention(now, batch_size)
                    await repo.tombstone_and_delete(
                        expired,
                        "retention",
                        now,
                        await history_cutoffs(repo, expired, now),
                        content_store().backend,
                    )
            deleted += len(expired)
            if len(expired) < batch_size:
                break
        for _ in range(max_batches):
            async with self.session_factory() as db:
                async with db.begin():
                    if not await self._claim(db):
                        return deleted
                    removed = await AgentSessionRepository(
                        db
                    ).delete_links_to_missing_work(batch_size)
            if removed < batch_size:
                break
        async with self.session_factory() as db:
            async with db.begin():
                if await self._claim(db):
                    await AgentSessionRepository(
                        db
                    ).delete_tombstones_of_revoked_devices()
        await self._sweep_expired_pairings(batch_size, max_batches)
        await SessionContentCleanup(self.session_factory, self._claim).run(
            batch_size, max_batches
        )
        if deleted:
            logger.info("session retention purged %d sessions", deleted)
        return deleted

    async def _sweep_expired_pairings(self, batch_size: int, max_batches: int) -> None:
        cutoff = datetime.now(timezone.utc) - PAIRING_SWEEP_GRACE
        swept = 0
        for _ in range(max_batches):
            async with self.session_factory() as db:
                async with db.begin():
                    if not await self._claim(db):
                        return
                    removed = await CompanionPairingRepository(
                        db
                    ).delete_expired_before(cutoff, batch_size)
            swept += removed
            if removed < batch_size:
                break
        if swept:
            logger.info("session retention swept %d expired pairings", swept)

    @staticmethod
    async def _claim(db) -> bool:
        """This batch's right to run; released when its transaction ends."""
        if db.get_bind().dialect.name != "postgresql":
            return True
        return bool(
            await db.scalar(select(func.pg_try_advisory_xact_lock(PURGE_LOCK_KEY)))
        )
