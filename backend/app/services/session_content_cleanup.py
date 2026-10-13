# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The retention job's share of session content (contract §10): expire
uploads nobody finished, delete the stored objects that deletions queued,
sweep objects no row accounts for, and recompute device totals that a
cascade the app never saw left behind.

Every database step owns a short transaction under the purge lock; store
calls run between them, never inside one. A step that fails is logged and
the next still runs, so one bad object can never stop the reconciliation."""

import logging
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.concurrency import run_in_threadpool

from app.core.session_content_keys import (
    CONTENT_ROOT,
    content_id_of,
    content_prefix,
    installation_prefix,
    uuid_of,
)
from app.models.companion import CompanionInstallation
from app.repositories.session_content import SessionContentRepository
from app.services.session_events import (
    Invalidation,
    publish_invalidations,
    session_updated,
)
from app.services.storage.session_content import (
    ContentStore,
    content_store,
    store_for,
)

logger = logging.getLogger(__name__)

# A claimed deletion is not retried by another pass for this long.
DELETION_LEASE = timedelta(minutes=10)
MAX_DELETION_BACKOFF = timedelta(hours=24)
# Objects younger than this may belong to an upload whose row is being written.
ORPHAN_MIN_AGE = timedelta(days=7)
ORPHAN_SWEEP_OBJECTS = 1000

Claim = Callable[[AsyncSession], Awaitable[bool]]


def deletion_backoff(attempts: int) -> timedelta:
    return min(timedelta(minutes=2**attempts), MAX_DELETION_BACKOFF)


def _named_children(prefixes: list[str]) -> dict:
    """Child prefixes by the uuid they are named after; a prefix named
    otherwise is not ours to judge and is left alone."""
    named = {}
    for prefix in prefixes:
        child = uuid_of(prefix.rstrip("/").rsplit("/", 1)[-1])
        if child is None:
            logger.warning("session content: unrecognized prefix %s left alone", prefix)
        else:
            named[child] = prefix
    return named


class SessionContentCleanup:
    def __init__(self, session_factory: async_sessionmaker, claim: Claim):
        self.session_factory = session_factory
        self.claim = claim

    async def run(self, batch_size: int, max_batches: int) -> None:
        steps = [
            ("expiry", lambda: self.expire_abandoned_uploads(batch_size, max_batches)),
            ("deletions", lambda: self.delete_queued_objects(batch_size, max_batches)),
            ("orphan sweep", lambda: self.sweep_orphans(content_store())),
            ("reconciliation", self.reconcile_device_totals),
        ]
        for name, step in steps:
            try:
                await step()
            except Exception:
                logger.exception("session content %s failed; the pass goes on", name)

    async def expire_abandoned_uploads(self, batch_size: int, max_batches: int) -> None:
        """A pending row has no backend of its own yet: its staging is
        queued in the store configured now."""
        expired = 0
        for _ in range(max_batches):
            invalidations: list[Invalidation] = []
            async with self.session_factory() as db:
                async with db.begin():
                    if not await self.claim(db):
                        return
                    repo = SessionContentRepository(db)
                    now = datetime.now(timezone.utc)
                    rows = await repo.lock_expired_uploads(now, batch_size)
                    for content in rows:
                        session = await repo.lock_session(content.session_id)
                        content.state = "recorded"
                        content.coverage = "expired"
                        content.coverage_reason = "staging_expired"
                        session.content_bytes -= content.byte_count or 0
                        await repo.add_installation_bytes(
                            content.installation_id, -(content.byte_count or 0)
                        )
                        await repo.queue_deletions(
                            content_store().backend, [content_prefix(content)], now
                        )
                        invalidations.append(
                            session_updated(session, "content_expired")
                        )
            await publish_invalidations(invalidations)
            expired += len(rows)
            if len(rows) < batch_size:
                break
        if expired:
            logger.info("session content: expired %d abandoned uploads", expired)

    async def delete_queued_objects(self, batch_size: int, max_batches: int) -> None:
        deleted = failed = 0
        for _ in range(max_batches):
            async with self.session_factory() as db:
                async with db.begin():
                    if not await self.claim(db):
                        return
                    now = datetime.now(timezone.utc)
                    claimed = [
                        (row.id, row.storage_backend, row.storage_prefix, row.attempts)
                        for row in await SessionContentRepository(
                            db
                        ).claim_due_deletions(now, now + DELETION_LEASE, batch_size)
                    ]
            results = []
            for deletion_id, backend, prefix, attempts in claimed:
                store = store_for(backend)
                try:
                    if store is None:
                        raise RuntimeError(f"content store {backend} is not configured")
                    await run_in_threadpool(store.delete_prefix, prefix)
                except Exception as error:
                    results.append(
                        (deletion_id, attempts, f"{type(error).__name__}: {error}")
                    )
                else:
                    results.append((deletion_id, attempts, None))
            async with self.session_factory() as db:
                async with db.begin():
                    repo = SessionContentRepository(db)
                    now = datetime.now(timezone.utc)
                    for deletion_id, attempts, error in results:
                        if error is None:
                            await repo.finish_deletion(deletion_id)
                            deleted += 1
                        else:
                            await repo.retry_deletion(
                                deletion_id, error, now + deletion_backoff(attempts + 1)
                            )
                            failed += 1
            if len(claimed) < batch_size:
                break
        if deleted or failed:
            logger.info(
                "session content: deleted %d stored prefixes, %d to retry",
                deleted,
                failed,
            )

    async def sweep_orphans(self, store: ContentStore) -> None:
        """Objects of workspaces and devices that no longer exist, then one
        live device's objects with no row, a page per pass."""
        swept = await self._drop_dead_prefixes(store)
        swept += await self._sweep_one_installation(store)
        if swept:
            logger.info("session content: swept %d orphaned objects", swept)

    async def reconcile_device_totals(self) -> None:
        async with self.session_factory() as db:
            async with db.begin():
                if not await self.claim(db):
                    return
                changed = await SessionContentRepository(
                    db
                ).reconcile_installation_bytes()
        if changed:
            logger.info("session content: reconciled %d devices", changed)

    async def _alive(self, lookup, ids) -> set | None:
        """Which of `ids` still have their row, or None without the purge lock."""
        async with self.session_factory() as db:
            async with db.begin():
                if not await self.claim(db):
                    return None
                return await lookup(SessionContentRepository(db), list(ids))

    async def _drop_dead_prefixes(self, store: ContentStore) -> int:
        workspaces = _named_children(
            await run_in_threadpool(store.list_prefixes, f"{CONTENT_ROOT}/")
        )
        alive = await self._alive(
            SessionContentRepository.workspace_ids_present, workspaces
        )
        if alive is None:
            return 0
        dropped = 0
        for workspace_id, prefix in workspaces.items():
            if workspace_id not in alive:
                dropped += await run_in_threadpool(store.delete_prefix, prefix)
            else:
                dropped += await self._drop_dead_installations(store, prefix)
        return dropped

    async def _drop_dead_installations(
        self, store: ContentStore, workspace: str
    ) -> int:
        installations = _named_children(
            [
                installation
                for owner in await run_in_threadpool(store.list_prefixes, workspace)
                for installation in await run_in_threadpool(store.list_prefixes, owner)
            ]
        )
        alive = await self._alive(
            SessionContentRepository.installation_ids_present, installations
        )
        if alive is None:
            return 0
        dropped = 0
        for installation_id, prefix in installations.items():
            if installation_id not in alive:
                dropped += await run_in_threadpool(store.delete_prefix, prefix)
        return dropped

    async def _sweep_one_installation(self, store: ContentStore) -> int:
        async with self.session_factory() as db:
            async with db.begin():
                if not await self.claim(db):
                    return 0
                repo = SessionContentRepository(db)
                installation = await repo.next_installation_to_sweep()
                if installation is None:
                    return 0
                installation_id, owner_id = installation.id, installation.owner_id
                cursor = installation.content_sweep_cursor
                workspaces = await repo.sweep_workspaces_of(installation)
        # Sessions that code without rich capture deleted (during a rollback)
        # left their bodies but no row naming their workspace.
        workspaces = sorted(
            set(workspaces)
            | await self._stored_workspaces(store, owner_id, installation_id)
        )
        listed, cursor = await self._page_of(
            store, workspaces, owner_id, installation_id, cursor
        )
        owners = {item.key: content_id_of(item.key) for item in listed}
        present = await self._alive(
            SessionContentRepository.content_ids_present,
            sorted({owner for owner in owners.values() if owner is not None}),
        )
        if present is None:
            return 0
        old_before = datetime.now(timezone.utc) - ORPHAN_MIN_AGE
        swept = 0
        for item in listed:
            # No row can own a key of no recognizable shape either.
            if owners[item.key] not in present and item.updated_at < old_before:
                await run_in_threadpool(store.delete, item.key)
                swept += 1
        async with self.session_factory() as db:
            async with db.begin():
                installation = await db.get(CompanionInstallation, installation_id)
                if installation is not None:
                    installation.content_sweep_cursor = cursor
                    installation.content_swept_at = datetime.now(timezone.utc)
        return swept

    @staticmethod
    async def _stored_workspaces(store, owner_id, installation_id) -> set:
        """The workspaces whose stored objects include this device's."""
        found = set()
        for prefix in await run_in_threadpool(store.list_prefixes, f"{CONTENT_ROOT}/"):
            workspace_id = uuid_of(prefix.rstrip("/").rsplit("/", 1)[-1])
            if workspace_id is None:
                continue
            devices = await run_in_threadpool(
                store.list_prefixes, f"{prefix}{owner_id}/"
            )
            if installation_prefix(workspace_id, owner_id, installation_id) in devices:
                found.add(workspace_id)
        return found

    @staticmethod
    async def _page_of(store, workspaces, owner_id, installation_id, cursor):
        """Up to ORPHAN_SWEEP_OBJECTS of the device's objects after `cursor`
        (a key), across its workspaces in key order; and the cursor to resume
        from, None once every workspace was listed to its end."""
        listed = []
        prefixes = sorted(
            installation_prefix(workspace_id, owner_id, installation_id)
            for workspace_id in workspaces
        )
        for prefix in prefixes:
            if cursor is not None and not (
                cursor.startswith(prefix) or prefix > cursor
            ):
                continue
            token = cursor if cursor is not None and cursor.startswith(prefix) else None
            page, more = await run_in_threadpool(
                store.list_objects, prefix, token, ORPHAN_SWEEP_OBJECTS - len(listed)
            )
            listed.extend(page)
            if more is not None:
                return listed, more
            if len(listed) >= ORPHAN_SWEEP_OBJECTS:
                later = [other for other in prefixes if other > prefix]
                return listed, (listed[-1].key if later else None)
        return listed, None
