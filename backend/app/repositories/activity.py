# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime, time, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.activity import Activity, ActivityAction, ActivityEntityType


class ActivityRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def record(self, **kwargs) -> Activity:
        # Microsecond app-clock timestamp: the DB clock ties within a request
        # (Postgres now() is transaction-frozen; SQLite CURRENT_TIMESTAMP has 1s
        # resolution), which makes created_at-ordered reads of same-request
        # activities nondeterministic.
        kwargs.setdefault("created_at", datetime.utcnow())
        activity = Activity(**kwargs)
        self.db.add(activity)
        await self.db.flush()
        return activity

    async def list_by_workspace(
        self,
        workspace_id: uuid.UUID,
        limit: int = 50,
        before: datetime | None = None,
        entity_type: ActivityEntityType | None = None,
        action: ActivityAction | None = None,
        actor_id: uuid.UUID | None = None,
        search: str | None = None,
        agent_id: uuid.UUID | None = None,
    ) -> list[Activity]:
        stmt = (
            select(Activity)
            .options(selectinload(Activity.actor))
            .where(Activity.workspace_id == workspace_id)
            .order_by(Activity.created_at.desc())
            .limit(limit)
        )
        if before:
            stmt = stmt.where(Activity.created_at < before)
        if entity_type:
            stmt = stmt.where(Activity.entity_type == entity_type)
        if action:
            stmt = stmt.where(Activity.action == action)
        if actor_id:
            stmt = stmt.where(Activity.actor_id == actor_id)
        if agent_id:
            stmt = stmt.where(Activity.agent_id == agent_id)
        if search:
            stmt = stmt.where(Activity.summary.ilike(f"%{search}%"))
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def daily_counts_by_workspace(
        self, workspace_id: uuid.UUID, today: date, days: int
    ) -> list[tuple[date, int]]:
        """Activity volume per calendar day for the sparkline, oldest day first.

        Returns exactly `days` entries including today, zero-filled — the caller
        renders a fixed-width chart, so a day with no activity must be a zero
        point rather than a missing one.

        `func.date()` is used rather than `date_trunc` because it is the one
        spelling both Postgres and the SQLite test DB accept; the two disagree
        on the return type (SQLite yields a string), so rows are keyed back onto
        the pre-built day list by ISO string rather than by parsed value.
        """
        oldest_day = today - timedelta(days=days - 1)
        window_start = datetime.combine(oldest_day, time.min)

        result = await self.db.execute(
            select(func.date(Activity.created_at), func.count(Activity.id))
            .where(Activity.workspace_id == workspace_id)
            .where(Activity.created_at >= window_start)
            .group_by(func.date(Activity.created_at))
        )
        counts_by_iso_day = {str(row[0]): row[1] for row in result.all()}

        return [
            (day, counts_by_iso_day.get(day.isoformat(), 0))
            for day in (oldest_day + timedelta(days=offset) for offset in range(days))
        ]

    async def list_board_timeline(
        self, board_id: uuid.UUID, limit: int = 5000
    ) -> list[Activity]:
        """Full board activity log in insertion order for the timeline simulator.

        Ordered by the monotonic `seq` key, NOT created_at: created_at has 1s
        resolution and `id` is a random uuid4, so a same-second burst would sort
        randomly and corrupt the FE forward fold. `seq` is strictly increasing in
        insertion order. Fetches `limit + 1` so the service can detect truncation.
        """
        stmt = (
            select(Activity)
            .options(selectinload(Activity.actor))
            .where(Activity.board_id == board_id)
            .order_by(Activity.seq.asc())
            .limit(limit + 1)
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def list_by_board(
        self,
        board_id: uuid.UUID,
        limit: int = 50,
        before: datetime | None = None,
        entity_type: ActivityEntityType | None = None,
        action: ActivityAction | None = None,
        actor_id: uuid.UUID | None = None,
        search: str | None = None,
        agent_id: uuid.UUID | None = None,
    ) -> list[Activity]:
        stmt = (
            select(Activity)
            .options(selectinload(Activity.actor))
            .where(Activity.board_id == board_id)
            .order_by(Activity.created_at.desc())
            .limit(limit)
        )
        if before:
            stmt = stmt.where(Activity.created_at < before)
        if entity_type:
            stmt = stmt.where(Activity.entity_type == entity_type)
        if action:
            stmt = stmt.where(Activity.action == action)
        if actor_id:
            stmt = stmt.where(Activity.actor_id == actor_id)
        if agent_id:
            stmt = stmt.where(Activity.agent_id == agent_id)
        if search:
            stmt = stmt.where(Activity.summary.ilike(f"%{search}%"))
        result = await self.db.execute(stmt)
        return list(result.scalars().all())
