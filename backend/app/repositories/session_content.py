# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import (
    AgentSession,
    AgentSessionCaptureGeneration,
    AgentSessionContent,
    AgentSessionContentDeletion,
)
from app.models.companion import CompanionInstallation
from app.models.workspace import Workspace
from app.repositories.dialect_insert import conflict_aware_insert


class SessionContentRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    # --- generations and declarations ---

    async def generation(
        self, installation_id: uuid.UUID, generation_key: str, defaults: dict
    ) -> AgentSessionCaptureGeneration:
        """The stored generation of this key, created from `defaults` when new."""
        await self.db.execute(
            conflict_aware_insert(self.db, AgentSessionCaptureGeneration)
            .values(
                id=uuid.uuid4(),
                installation_id=installation_id,
                generation_key=generation_key,
                **defaults,
            )
            .on_conflict_do_nothing(
                index_elements=["installation_id", "generation_key"]
            )
        )
        return await self.db.scalar(
            select(AgentSessionCaptureGeneration).where(
                AgentSessionCaptureGeneration.installation_id == installation_id,
                AgentSessionCaptureGeneration.generation_key == generation_key,
            )
        )

    async def by_keys(
        self, session_id: uuid.UUID, keys: list[str]
    ) -> dict[str, AgentSessionContent]:
        if not keys:
            return {}
        rows = await self.db.scalars(
            select(AgentSessionContent).where(
                AgentSessionContent.session_id == session_id,
                AgentSessionContent.content_key.in_(keys),
            )
        )
        return {row.content_key: row for row in rows}

    async def add(self, content: AgentSessionContent) -> None:
        self.db.add(content)
        await self.db.flush()

    # --- counters, in the lock order sessions then installation ---

    async def lock_session(self, session_id: uuid.UUID) -> AgentSession | None:
        return await self.db.scalar(
            select(AgentSession)
            .where(AgentSession.id == session_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )

    async def add_installation_bytes(
        self, installation_id: uuid.UUID, delta: int
    ) -> None:
        if delta:
            await self.db.execute(
                update(CompanionInstallation)
                .where(CompanionInstallation.id == installation_id)
                .values(content_bytes=CompanionInstallation.content_bytes + delta)
                .execution_options(synchronize_session=False)
            )

    async def reconcile_installation_bytes(self) -> int:
        """Set each device's total to what its sessions hold, where they
        differ (a cascade the app never saw); returns how many changed. Each
        device row is locked before its sessions are summed, so an ingest
        committing meanwhile lands on the recomputed total, not under it."""
        held = (
            select(func.coalesce(func.sum(AgentSession.content_bytes), 0))
            .where(AgentSession.installation_id == CompanionInstallation.id)
            .scalar_subquery()
        )
        drifted = list(
            await self.db.scalars(
                select(CompanionInstallation.id)
                .where(CompanionInstallation.content_bytes != held)
                .order_by(CompanionInstallation.id)
                .with_for_update(skip_locked=True)
            )
        )
        for installation_id in drifted:
            total = await self.db.scalar(
                select(func.coalesce(func.sum(AgentSession.content_bytes), 0)).where(
                    AgentSession.installation_id == installation_id
                )
            )
            await self.db.execute(
                update(CompanionInstallation)
                .where(CompanionInstallation.id == installation_id)
                .values(content_bytes=total)
                .execution_options(synchronize_session=False)
            )
        return len(drifted)

    # --- device and owner lookups, always scoped ---

    async def of_installation(
        self,
        content_id: uuid.UUID,
        installation_id: uuid.UUID,
        *,
        for_update: bool = False,
    ) -> AgentSessionContent | None:
        query = select(AgentSessionContent).where(
            AgentSessionContent.id == content_id,
            AgentSessionContent.installation_id == installation_id,
        )
        if for_update:
            query = query.with_for_update()
        return await self.db.scalar(query.execution_options(populate_existing=True))

    async def of_owner(
        self,
        content_id: uuid.UUID,
        session_id: uuid.UUID,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
    ) -> AgentSessionContent | None:
        return await self.db.scalar(
            select(AgentSessionContent).where(
                AgentSessionContent.id == content_id,
                AgentSessionContent.session_id == session_id,
                AgentSessionContent.workspace_id == workspace_id,
                AgentSessionContent.owner_id == owner_id,
            )
        )

    async def many_of_owner(
        self,
        content_ids: list[uuid.UUID],
        session_id: uuid.UUID,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
    ) -> list[AgentSessionContent]:
        rows = await self.db.scalars(
            select(AgentSessionContent).where(
                AgentSessionContent.id.in_(content_ids),
                AgentSessionContent.session_id == session_id,
                AgentSessionContent.workspace_id == workspace_id,
                AgentSessionContent.owner_id == owner_id,
            )
        )
        return list(rows)

    async def page(
        self,
        session_id: uuid.UUID,
        *,
        channel: str | None,
        call_key: str | None,
        event_id: str | None,
        after: tuple[datetime, int, uuid.UUID] | None,
        limit: int,
    ) -> list[AgentSessionContent]:
        query = select(AgentSessionContent).where(
            AgentSessionContent.session_id == session_id
        )
        if channel is not None:
            query = query.where(AgentSessionContent.channel == channel)
        if call_key is not None:
            query = query.where(AgentSessionContent.call_key == call_key)
        if event_id is not None:
            query = query.where(AgentSessionContent.event_id == event_id)
        if after is not None:
            at, order, row_id = after
            query = query.where(
                or_(
                    AgentSessionContent.occurred_at > at,
                    and_(
                        AgentSessionContent.occurred_at == at,
                        or_(
                            AgentSessionContent.source_order > order,
                            and_(
                                AgentSessionContent.source_order == order,
                                AgentSessionContent.id > row_id,
                            ),
                        ),
                    ),
                )
            )
        rows = await self.db.scalars(
            query.order_by(
                AgentSessionContent.occurred_at,
                AgentSessionContent.source_order,
                AgentSessionContent.id,
            ).limit(limit)
        )
        return list(rows)

    # --- the deletion queue ---

    async def queue_deletions(
        self, backend: str, prefixes: list[str], now: datetime
    ) -> None:
        for prefix in prefixes:
            self.db.add(
                AgentSessionContentDeletion(
                    storage_backend=backend,
                    storage_prefix=prefix,
                    requested_at=now,
                    next_attempt_at=now,
                )
            )
        await self.db.flush()

    async def claim_due_deletions(
        self, now: datetime, lease_until: datetime, limit: int
    ) -> list[AgentSessionContentDeletion]:
        """Due rows, leased so a concurrent pass skips them while this one
        talks to the store outside any transaction."""
        rows = list(
            await self.db.scalars(
                select(AgentSessionContentDeletion)
                .where(AgentSessionContentDeletion.next_attempt_at <= now)
                .order_by(
                    AgentSessionContentDeletion.next_attempt_at,
                    AgentSessionContentDeletion.id,
                )
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        for row in rows:
            row.next_attempt_at = lease_until
        await self.db.flush()
        return rows

    async def finish_deletion(self, deletion_id: uuid.UUID) -> None:
        await self.db.execute(
            delete(AgentSessionContentDeletion)
            .where(AgentSessionContentDeletion.id == deletion_id)
            .execution_options(synchronize_session=False)
        )

    async def retry_deletion(
        self, deletion_id: uuid.UUID, error: str, next_attempt_at: datetime
    ) -> None:
        await self.db.execute(
            update(AgentSessionContentDeletion)
            .where(AgentSessionContentDeletion.id == deletion_id)
            .values(
                attempts=AgentSessionContentDeletion.attempts + 1,
                last_error=error[:1024],
                next_attempt_at=next_attempt_at,
            )
            .execution_options(synchronize_session=False)
        )

    # --- sweeps ---

    async def lock_expired_uploads(
        self, now: datetime, limit: int
    ) -> list[AgentSessionContent]:
        """Pending uploads past their deadline, sessions locked first in id
        order, then the rows."""
        expired = (
            select(AgentSessionContent.id, AgentSessionContent.session_id)
            .where(
                AgentSessionContent.state == "pending",
                AgentSessionContent.upload_expires_at < now,
            )
            .order_by(AgentSessionContent.session_id, AgentSessionContent.id)
            .limit(limit)
        )
        found = (await self.db.execute(expired)).all()
        for session_id in sorted({session_id for _, session_id in found}):
            await self.lock_session(session_id)
        rows = await self.db.scalars(
            select(AgentSessionContent)
            .where(
                AgentSessionContent.id.in_([content_id for content_id, _ in found]),
                AgentSessionContent.state == "pending",
            )
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        return list(rows)

    async def workspace_ids_present(self, ids: list[uuid.UUID]) -> set[uuid.UUID]:
        if not ids:
            return set()
        return set(
            await self.db.scalars(select(Workspace.id).where(Workspace.id.in_(ids)))
        )

    async def installation_ids_present(self, ids: list[uuid.UUID]) -> set[uuid.UUID]:
        if not ids:
            return set()
        return set(
            await self.db.scalars(
                select(CompanionInstallation.id).where(
                    CompanionInstallation.id.in_(ids)
                )
            )
        )

    async def next_installation_to_sweep(self) -> CompanionInstallation | None:
        """The live device swept least recently (never swept first)."""
        return await self.db.scalar(
            select(CompanionInstallation)
            .where(CompanionInstallation.revoked_at.is_(None))
            .order_by(
                CompanionInstallation.content_swept_at.is_not(None),
                CompanionInstallation.content_swept_at,
                CompanionInstallation.id,
            )
            .limit(1)
            .with_for_update(skip_locked=True)
        )

    async def content_ids_present(self, ids: list[uuid.UUID]) -> set[uuid.UUID]:
        if not ids:
            return set()
        return set(
            await self.db.scalars(
                select(AgentSessionContent.id).where(AgentSessionContent.id.in_(ids))
            )
        )

    async def sweep_workspaces_of(
        self, installation: CompanionInstallation
    ) -> list[uuid.UUID]:
        """The workspaces under which this device may have stored bodies."""
        return sorted(
            set(
                await self.db.scalars(
                    select(AgentSession.workspace_id)
                    .where(AgentSession.installation_id == installation.id)
                    .distinct()
                )
            )
        )
