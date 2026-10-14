# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from datetime import timedelta

from sqlalchemy import and_, cast, delete, false, func, not_, or_, select, Text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.activity_transaction import TransactionSnapshot
from app.models.timeline import (
    TimelineCheckpoint,
    TimelineGeneration,
    TimelinePreparation,
)
from app.models.workspace import Workspace, WorkspaceMember
from app.models.user import User
from app.models.kanban.board import Board


MAX_CHECKPOINTS_PER_GENERATION = 64


class TimelineRepository:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.postgres = db.bind.dialect.name == "postgresql"

    async def workspace(self, slug):
        return await self.db.scalar(select(Workspace).where(Workspace.slug == slug))

    async def membership(self, workspace_id, user_id):
        return await self.db.get(WorkspaceMember, (workspace_id, user_id))

    async def board(self, workspace_id, identifier):
        try:
            condition = Board.id == uuid.UUID(str(identifier))
        except ValueError:
            condition = Board.slug == identifier
        return await self.db.scalar(
            select(Board).where(Board.workspace_id == workspace_id, condition)
        )

    async def generation(
        self, board_id, generation_id=None, request_id=None, lock=False
    ):
        stmt = select(TimelineGeneration).where(TimelineGeneration.board_id == board_id)
        stmt = (
            stmt.where(TimelineGeneration.id == generation_id)
            if generation_id
            else stmt.where(TimelineGeneration.request_id == request_id)
        )
        if lock:
            stmt = stmt.with_for_update()
        return await self.db.scalar(stmt.execution_options(populate_existing=True))

    def visible(self, generation):
        if generation.head_seq is None:
            return false()
        conditions = [
            Activity.board_id == generation.board_id,
            Activity.seq <= generation.head_seq,
        ]
        if self.postgres:
            conditions.append(
                or_(
                    Activity.recorded_transaction.is_(None),
                    func.pg_visible_in_snapshot(
                        Activity.recorded_transaction,
                        cast(
                            cast(generation.source_snapshot, Text),
                            TransactionSnapshot(),
                        ),
                    ),
                )
            )
        else:
            # SQLite has no exportable MVCC snapshot. Only the local/test dialect
            # materializes membership; production never builds an ID manifest.
            conditions.append(
                Activity.id.in_(
                    [
                        uuid.UUID(value)
                        for value in json.loads(generation.source_snapshot)
                    ]
                )
            )
        return and_(*conditions)

    async def observed_state(self, generation_id):
        return await self.db.scalar(
            select(TimelineGeneration.observed_state).where(
                TimelineGeneration.id == generation_id,
            )
        )

    async def source_snapshot(self, board_id):
        if self.postgres:
            return await self.db.scalar(select(cast(func.pg_current_snapshot(), Text)))
        ids = (
            await self.db.scalars(
                select(Activity.id).where(Activity.board_id == board_id)
            )
        ).all()
        return json.dumps([str(value) for value in ids])

    async def actor_labels(self, generation):
        rows = (
            await self.db.execute(
                select(User.id, User.name)
                .join(
                    Activity,
                    Activity.actor_id == User.id,
                )
                .where(self.visible(generation))
                .distinct()
            )
        ).all()
        return {str(row.id): {"name": row.name} for row in rows}

    async def bounds(self, board_id):
        return (
            await self.db.execute(
                select(
                    func.min(Activity.seq),
                    func.max(Activity.seq),
                    func.count(Activity.id),
                    func.min(Activity.created_at),
                    func.max(Activity.created_at),
                ).where(Activity.board_id == board_id)
            )
        ).one()

    async def known_empty_genesis(self, generation):
        stmt = (
            select(Activity.seq, Activity.recorded_transaction, Activity.changes)
            .where(
                self.visible(generation),
                Activity.entity_type == ActivityEntityType.board,
                Activity.entity_id == generation.board_id,
                Activity.action == ActivityAction.created,
            )
            .order_by(Activity.seq)
            .limit(1)
        )
        row = (await self.db.execute(stmt)).first()
        if row is None or (row.changes or {}).get("timeline_genesis") != {
            "version": 1,
            "known_empty": True,
        }:
            return False
        if self.postgres:
            if row.recorded_transaction is None:
                return False
            conflicting = or_(
                Activity.recorded_transaction.is_(None),
                cast(Activity.recorded_transaction, Text)
                != str(row.recorded_transaction),
            )
        else:
            conflicting = not_(
                and_(
                    Activity.entity_type == ActivityEntityType.column,
                    Activity.action == ActivityAction.created,
                )
            )
        earlier = (
            select(Activity.id)
            .where(self.visible(generation), Activity.seq < row.seq, conflicting)
            .limit(1)
        )
        return await self.db.scalar(earlier) is None

    async def page(
        self,
        generation,
        *,
        limit,
        after=None,
        before=None,
        start=None,
        descending=False,
    ):
        stmt = select(Activity).where(self.visible(generation))
        if after is not None:
            stmt = stmt.where(Activity.seq > after)
        if before is not None:
            stmt = stmt.where(Activity.seq < before)
        if start is not None:
            stmt = stmt.where(Activity.seq >= start)
        stmt = stmt.order_by(Activity.seq.desc() if descending else Activity.seq).limit(
            limit
        )
        rows = list((await self.db.scalars(stmt)).all())
        return list(reversed(rows)) if descending else rows

    async def predecessor(self, generation, seq):
        return await self.db.scalar(
            select(func.max(Activity.seq)).where(
                self.visible(generation), Activity.seq < seq
            )
        )

    async def successor(self, generation, seq):
        return await self.db.scalar(
            select(func.min(Activity.seq)).where(
                self.visible(generation), Activity.seq > seq
            )
        )

    async def seek(self, generation, *, seq=None, at_time=None):
        stmt = select(Activity.seq).where(self.visible(generation))
        if seq is not None:
            found = await self.db.scalar(
                stmt.where(Activity.seq >= seq).order_by(Activity.seq).limit(1)
            )
            return found if found is not None else generation.head_seq
        if self.postgres:
            distance = func.abs(
                func.extract(
                    "epoch", Activity.created_at - at_time.replace(tzinfo=None)
                )
            )
        else:
            distance = func.abs(
                func.julianday(Activity.created_at) - func.julianday(at_time)
            )
        return await self.db.scalar(stmt.order_by(distance, Activity.seq).limit(1))

    async def overview(self, generation, buckets):
        if not generation.event_count:
            return []
        span = (generation.last_at - generation.first_at).total_seconds()
        width = max(span / buckets, 0.000001)
        if self.postgres:
            elapsed = (
                func.extract("epoch", Activity.created_at)
                - generation.first_at.timestamp()
            )
        else:
            elapsed = (
                func.julianday(Activity.created_at)
                - func.julianday(generation.first_at)
            ) * 86400.0
        index = func.floor(elapsed / width)
        # Include the exact last timestamp in the final bucket.
        from sqlalchemy import case

        index = case((index >= buckets, buckets - 1), (index < 0, 0), else_=index)
        stmt = (
            select(
                index.label("bucket"),
                func.count(Activity.id),
                func.min(Activity.seq),
                func.max(Activity.seq),
            )
            .where(self.visible(generation))
            .group_by(index)
            .order_by(index)
        )
        result = []
        for bucket, count, first, last in (await self.db.execute(stmt)).all():
            start = generation.first_at + timedelta(seconds=int(bucket) * width)
            end = max(
                start + timedelta(seconds=width), start + timedelta(microseconds=1)
            )
            result.append(
                {
                    "start_at": start,
                    "end_at": end,
                    "count": str(count),
                    "first_seq": str(first),
                    "last_seq": str(last),
                }
            )
        return result

    async def search(self, generation, query, limit, after=None):
        stmt = select(
            Activity.id, Activity.seq, Activity.created_at, Activity.summary
        ).where(
            self.visible(generation),
            Activity.summary.ilike(
                f"%{query.replace('/', '//').replace('%', '/%').replace('_', '/_')}%",
                escape="/",
            ),
        )
        if after is not None:
            stmt = stmt.where(Activity.seq > after)
        return (await self.db.execute(stmt.order_by(Activity.seq).limit(limit))).all()

    async def checkpoint(self, generation_id, target):
        return await self.db.scalar(
            select(TimelineCheckpoint)
            .where(
                TimelineCheckpoint.generation_id == generation_id,
                TimelineCheckpoint.through_seq <= target,
            )
            .order_by(TimelineCheckpoint.through_seq.desc())
            .limit(1)
        )

    async def reusable_checkpoints(self, generation, target):
        stmt = (
            select(TimelineCheckpoint, TimelineGeneration)
            .join(TimelineGeneration)
            .where(
                TimelineGeneration.board_id == generation.board_id,
                TimelineGeneration.id != generation.id,
                TimelineGeneration.schema_version == generation.schema_version,
                TimelineGeneration.known_empty_genesis
                == generation.known_empty_genesis,
                TimelineGeneration.created_at <= generation.created_at,
                TimelineCheckpoint.through_seq <= target,
            )
            .order_by(TimelineCheckpoint.through_seq.desc())
            .limit(8)
        )
        return (await self.db.execute(stmt)).all()

    async def prefix_unchanged(self, old, new, through_seq):
        changed = or_(
            and_(self.visible(old), not_(self.visible(new))),
            and_(self.visible(new), not_(self.visible(old))),
        )
        return (
            await self.db.scalar(
                select(Activity.id)
                .where(
                    Activity.board_id == new.board_id,
                    Activity.seq <= through_seq,
                    changed,
                )
                .limit(1)
            )
            is None
        )

    async def save_checkpoint(
        self, generation_id, through_seq, processed_events, result
    ):
        checkpoint = await self.checkpoint(generation_id, through_seq)
        if checkpoint is not None and checkpoint.through_seq == through_seq:
            return checkpoint
        checkpoint = TimelineCheckpoint(
            generation_id=generation_id,
            through_seq=through_seq,
            processed_events=processed_events,
            **result,
        )
        self.db.add(checkpoint)
        await self.db.flush()
        retained = (
            select(TimelineCheckpoint.id)
            .where(
                TimelineCheckpoint.generation_id == generation_id,
                TimelineCheckpoint.through_seq != through_seq,
            )
            .order_by(TimelineCheckpoint.through_seq.desc())
            .limit(MAX_CHECKPOINTS_PER_GENERATION - 1)
        )
        await self.db.execute(
            delete(TimelineCheckpoint)
            .where(
                TimelineCheckpoint.generation_id == generation_id,
                TimelineCheckpoint.through_seq != through_seq,
                TimelineCheckpoint.id.not_in(retained),
            )
            .execution_options(synchronize_session=False)
        )
        return checkpoint

    async def preparation(self, generation_id, *, target=None, preparation_id=None):
        stmt = select(TimelinePreparation).where(
            TimelinePreparation.generation_id == generation_id
        )
        stmt = (
            stmt.where(TimelinePreparation.id == preparation_id)
            if preparation_id
            else stmt.where(TimelinePreparation.target_seq == target)
        )
        return await self.db.scalar(stmt)

    async def pending(self, now):
        # Finish shorter prefixes first; round-robin work could repeatedly evict
        # dormant jobs' anchors without completing any. Later targets may wait.
        return await self.db.scalar(
            select(TimelinePreparation)
            .join(TimelineGeneration)
            .where(
                TimelinePreparation.status == "preparing",
                TimelineGeneration.expires_at > now,
            )
            .order_by(TimelinePreparation.target_seq, TimelinePreparation.id)
            .with_for_update(
                skip_locked=True, of=[TimelinePreparation, TimelineGeneration]
            )
            .limit(1)
        )

    async def cleanup_expired(self, now, limit=10):
        generations = list(
            (
                await self.db.scalars(
                    select(TimelineGeneration)
                    .where(
                        TimelineGeneration.expires_at <= now,
                        TimelineGeneration.source_snapshot != "",
                    )
                    .limit(limit)
                    .with_for_update(skip_locked=True)
                )
            ).all()
        )
        for generation in generations:
            await self.db.execute(
                delete(TimelineCheckpoint).where(
                    TimelineCheckpoint.generation_id == generation.id
                )
            )
            await self.db.execute(
                delete(TimelinePreparation).where(
                    TimelinePreparation.generation_id == generation.id
                )
            )
            generation.actor_labels = {}
            generation.observed_state = {}
            generation.source_snapshot = ""
            generation.cursor_secret = ""
        return len(generations)
