# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.sql import Insert
from sqlalchemy.sql.expression import ColumnElement

from app.models.notifications.notification import Notification
from app.repositories.base import BaseRepository
from app.utils import utcnow

# INV-6 backstop the upsert targets. PG can name the constraint directly; SQLite's
# ON CONFLICT only accepts index_elements (the constraint's columns), so we key
# the SQLite target on the same (recipient_user_id, dedupe_key) pair the unique
# constraint covers — identical dedupe semantics, different conflict-target syntax.
_DEDUPE_CONSTRAINT = "uq_notifications_recipient_dedupe"
_DEDUPE_COLUMNS = ("recipient_user_id", "dedupe_key")


class NotificationRepository(BaseRepository[Notification]):
    model = Notification

    @staticmethod
    def build_upsert_stmt(*, dialect_name: str = "postgresql", **kwargs) -> Insert:
        """INV-6 idempotent INSERT as a real upsert: `INSERT ... ON CONFLICT
        (uq_notifications_recipient_dedupe) DO NOTHING`. A SELECT-then-INSERT had
        a TOCTOU window where a concurrent generator (the same event fanned from
        two pipeline stages) could both pass the SELECT and one raise an
        IntegrityError — which on asyncpg POISONS the whole txn (InFailedSql), so
        the outer get_db commit then rolls the triggering mutation back. ON
        CONFLICT DO NOTHING removes the error entirely: the txn is never tainted.

        Dialect-aware: pg names the constraint (`constraint=`); SQLite's ON
        CONFLICT clause only accepts `index_elements`, so it targets the same
        columns the unique constraint covers. The named-constraint form on PG is
        why a compile-against-PG assertion can prove the shape with no live PG."""
        if dialect_name == "postgresql":
            return (
                pg_insert(Notification)
                .values(**kwargs)
                .on_conflict_do_nothing(constraint=_DEDUPE_CONSTRAINT)
            )
        return (
            sqlite_insert(Notification)
            .values(**kwargs)
            .on_conflict_do_nothing(index_elements=list(_DEDUPE_COLUMNS))
        )

    async def create(self, **kwargs) -> Notification:
        """INV-6 idempotent: re-running generation for the same
        (recipient_user_id, dedupe_key) is a no-op upsert. Returns the persisted
        row (just-inserted OR pre-existing). No IntegrityError is ever raised, so
        the surrounding txn is never poisoned (the asyncpg failure mode that
        would otherwise roll the triggering mutation back)."""
        stmt = self.build_upsert_stmt(dialect_name=self.db.bind.dialect.name, **kwargs)
        await self.db.execute(stmt)
        # ON CONFLICT DO NOTHING returns nothing on conflict, so we can't rely on
        # RETURNING — always re-SELECT by the dedupe identity to return the row
        # (the just-inserted one or the pre-existing winner of the race).
        row = await self._get_by_dedupe(
            kwargs["recipient_user_id"], kwargs["dedupe_key"]
        )
        assert row is not None  # the row exists post-insert (inserted or conflicted)
        return row

    async def _get_by_dedupe(
        self, recipient_user_id: uuid.UUID, dedupe_key: str
    ) -> Notification | None:
        result = await self.db.execute(
            select(Notification).where(
                Notification.recipient_user_id == recipient_user_id,
                Notification.dedupe_key == dedupe_key,
            )
        )
        return result.scalar_one_or_none()

    async def list_for_recipient(
        self,
        recipient_user_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
        limit: int = 50,
        before: datetime | None = None,
        unread_only: bool = False,
    ) -> list[Notification]:
        stmt = (
            select(Notification)
            .where(Notification.recipient_user_id == recipient_user_id)
            .order_by(Notification.created_at.desc())
            .limit(limit)
        )
        if workspace_id is not None:
            stmt = stmt.where(Notification.workspace_id == workspace_id)
        if before is not None:
            stmt = stmt.where(Notification.created_at < before)
        if unread_only:
            stmt = stmt.where(Notification.read_at.is_(None))
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def unread_count(
        self,
        recipient_user_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
    ) -> int:
        stmt = (
            select(func.count())
            .select_from(Notification)
            .where(
                Notification.recipient_user_id == recipient_user_id,
                Notification.read_at.is_(None),
            )
        )
        if workspace_id is not None:
            stmt = stmt.where(Notification.workspace_id == workspace_id)
        result = await self.db.execute(stmt)
        return result.scalar_one()

    async def mark_read(self, notification: Notification) -> Notification:
        # Idempotent: keep the original read_at if already read.
        if notification.read_at is None:
            notification.read_at = utcnow()
            await self.db.flush()
            await self.db.refresh(notification)
        return notification

    async def mark_all_read(
        self,
        recipient_user_id: uuid.UUID,
        workspace_id: uuid.UUID | None = None,
    ) -> None:
        conditions: list[ColumnElement[bool]] = [
            Notification.recipient_user_id == recipient_user_id,
            Notification.read_at.is_(None),
        ]
        if workspace_id is not None:
            conditions.append(Notification.workspace_id == workspace_id)
        await self.db.execute(
            update(Notification).where(*conditions).values(read_at=utcnow())
        )
        await self.db.flush()
