# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pure data-access for the PAR-2 merge queue.

The repository owns SQL only. State-machine validation, idempotency policy,
and event emission live in app.services.merge_queue.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Iterable

from sqlalchemy import and_, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.kanban.card import Card

# Every non-terminal state. `blocked_pending_consolidation` belongs here even
# though nothing is draining it: PAR-3b parks an entry there until a human or a
# consolidator card revives it via re_enqueue_parent, so it is work-in-flight
# the operator has to see. Only `merged` is terminal, and it is reachable
# solely through the bounded merged_since window.
WORKSPACE_ACTIVE_STATES = (
    "queued",
    "merging",
    "conflict",
    "failed",
    "blocked_pending_consolidation",
)


class MergeQueueRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def repository_scopes(self, repo_ids):
        from app.models.git.git_repo import GitRepo
        rows = await self.db.execute(select(GitRepo.id, GitRepo.workspace_id, GitRepo.board_id).where(GitRepo.id.in_(repo_ids)))
        return {repo_id: (workspace_id, board_id) for repo_id, workspace_id, board_id in rows}

    async def enqueue_scope(self, card_id, repo_id, workspace_id):
        from app.models.git.git_repo import GitRepo
        from app.models.kanban.board import Board
        from app.models.kanban.card import Card

        return (await self.db.execute(
            select(Card, Board, GitRepo)
            .join(Board, Board.id == Card.board_id)
            .join(GitRepo, GitRepo.board_id == Board.id)
            .where(Card.id == card_id, GitRepo.id == repo_id,
                   Board.workspace_id == workspace_id,
                   GitRepo.workspace_id == workspace_id)
        )).first()

    async def enqueue(
        self,
        *,
        repo_id: uuid.UUID,
        integration_branch: str,
        card_id: uuid.UUID,
        pr_url: str,
        pr_branch: str,
        workspace_id: uuid.UUID,
    ) -> MergeQueueEntry:
        entry = MergeQueueEntry(
            repo_id=repo_id,
            integration_branch=integration_branch,
            card_id=card_id,
            pr_url=pr_url,
            pr_branch=pr_branch,
            workspace_id=workspace_id,
            state="queued",
            attempt_count=0,
            first_enqueued_at=datetime.utcnow(),
        )
        self.db.add(entry)
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def get(self, entry_id: uuid.UUID) -> MergeQueueEntry | None:
        result = await self.db.execute(
            select(MergeQueueEntry).where(MergeQueueEntry.id == entry_id)
        )
        return result.scalar_one_or_none()

    async def get_by_card_id(self, card_id: uuid.UUID) -> MergeQueueEntry | None:
        result = await self.db.execute(
            select(MergeQueueEntry).where(MergeQueueEntry.card_id == card_id)
        )
        return result.scalar_one_or_none()

    async def pop_next(
        self, *, repo_id: uuid.UUID, integration_branch: str
    ) -> MergeQueueEntry | None:
        """Return the oldest queued entry for (repo_id, integration_branch).

        Postgres path uses SELECT FOR UPDATE SKIP LOCKED so two backend
        replicas calling this concurrently never lock the same row — a
        cheaper substitute for a distributed lock. SQLite (test DB) does
        not implement those hints; the ORM silently drops them, and we
        rely on transaction isolation in tests.
        """
        stmt = (
            select(MergeQueueEntry)
            .where(MergeQueueEntry.repo_id == repo_id)
            .where(MergeQueueEntry.integration_branch == integration_branch)
            .where(MergeQueueEntry.state == "queued")
            .order_by(MergeQueueEntry.enqueued_at.asc())
            .limit(1)
        )
        dialect = self.db.bind.dialect.name if self.db.bind is not None else ""
        if dialect == "postgresql":
            stmt = stmt.with_for_update(skip_locked=True)
        result = await self.db.execute(stmt)
        return result.scalar_one_or_none()

    async def mark_merging(self, entry_id: uuid.UUID) -> MergeQueueEntry:
        entry = await self._require(entry_id)
        entry.state = "merging"
        entry.attempt_count = (entry.attempt_count or 0) + 1
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def mark_merged(
        self, entry_id: uuid.UUID, *, merged_at: datetime
    ) -> MergeQueueEntry:
        entry = await self._require(entry_id)
        entry.state = "merged"
        entry.merged_at = merged_at
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def mark_conflict(
        self, entry_id: uuid.UUID, *, error_message: str
    ) -> MergeQueueEntry:
        entry = await self._require(entry_id)
        entry.state = "conflict"
        entry.error_message = error_message
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def mark_failed(
        self, entry_id: uuid.UUID, *, error_message: str
    ) -> MergeQueueEntry:
        entry = await self._require(entry_id)
        entry.state = "failed"
        entry.error_message = error_message
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def mark_blocked_pending_consolidation(
        self, entry_id: uuid.UUID
    ) -> MergeQueueEntry:
        """Move an entry from `conflict` to `blocked_pending_consolidation`.

        PAR-3c: signals "a consolidator card now exists for this conflict;
        don't surface as raw `conflict` in operator UIs". The error_message
        from mark_conflict is preserved — the consolidator card carries the
        same body but the queue row keeps it for forensics.
        """
        entry = await self._require(entry_id)
        entry.state = "blocked_pending_consolidation"
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def re_enqueue(
        self, entry_id: uuid.UUID, *, retry_reason: str | None = None
    ) -> MergeQueueEntry:
        """Reset an entry back to `queued`, incrementing attempt_count.

        Idempotent: callers that re-invoke against an already-queued entry
        get the row back unchanged. Re-entering means the BACK of the FIFO —
        `enqueued_at` is bumped so a churning entry cannot starve fresh ones
        behind it (field report 2026-08-08: two ci_not_green churners pinned
        two fresh entries at attempt_count=0). `retry_reason` is stored on
        error_message so a queued-but-churning entry shows WHY; omitted, the
        message clears (clean slate for human/consolidator re-queues).

        `first_enqueued_at` is deliberately NOT bumped — it is how long the
        entry has been stuck, and bumping it alongside enqueued_at is what hid
        hot retry loops from the stale detector. A legacy row carrying NULL
        adopts its current enqueued_at here rather than restarting the clock.
        """
        entry = await self._require(entry_id)
        if entry.state == "queued":
            return entry
        entry.state = "queued"
        entry.attempt_count = (entry.attempt_count or 0) + 1
        entry.error_message = retry_reason
        if entry.first_enqueued_at is None:
            entry.first_enqueued_at = entry.enqueued_at
        entry.enqueued_at = datetime.utcnow()
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def list_active(
        self,
        *,
        repo_id: uuid.UUID,
        integration_branch: str,
        states: Iterable[str] = ("queued", "merging"),
    ) -> list[MergeQueueEntry]:
        states_tuple = tuple(states)
        stmt = (
            select(MergeQueueEntry)
            .where(MergeQueueEntry.repo_id == repo_id)
            .where(MergeQueueEntry.integration_branch == integration_branch)
            .where(MergeQueueEntry.state.in_(states_tuple))
            .order_by(MergeQueueEntry.enqueued_at.asc())
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def list_workspace_active(
        self,
        *,
        workspace_id: uuid.UUID,
        states: Iterable[str] = WORKSPACE_ACTIVE_STATES,
        merged_since: datetime | None = None,
    ) -> list[MergeQueueEntry]:
        """Workspace entries in `states`, plus merged ones since `merged_since`.

        The merged arm is a separate OR rather than another member of `states`
        because it must stay bounded: `merged` is terminal and its rows only
        ever accumulate, so it is reachable only through a time window.
        """
        states_tuple = tuple(states)
        in_states = MergeQueueEntry.state.in_(states_tuple)
        if merged_since is not None:
            recently_merged = and_(
                MergeQueueEntry.state == "merged",
                MergeQueueEntry.merged_at.is_not(None),
                MergeQueueEntry.merged_at >= merged_since,
            )
            state_filter = or_(in_states, recently_merged)
        else:
            state_filter = in_states

        stmt = (
            select(MergeQueueEntry)
            .where(MergeQueueEntry.workspace_id == workspace_id)
            .where(state_filter)
            .order_by(MergeQueueEntry.enqueued_at.asc())
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def list_board_active(
        self,
        *,
        board_id: uuid.UUID,
        states: Iterable[str] = ("queued", "merging"),
    ) -> list[MergeQueueEntry]:
        """Entries still in flight for a board.

        Entries carry no board_id — the board is reached through the card they
        merge, so this joins rather than filtering a denormalized column.
        """
        states_tuple = tuple(states)
        stmt = (
            select(MergeQueueEntry)
            .join(Card, Card.id == MergeQueueEntry.card_id)
            .where(Card.board_id == board_id)
            .where(MergeQueueEntry.state.in_(states_tuple))
            .order_by(MergeQueueEntry.enqueued_at.asc())
        )
        result = await self.db.execute(stmt)
        return list(result.scalars().all())

    async def distinct_active_keys(
        self, *, states: Iterable[str] = ("queued",)
    ) -> list[tuple[uuid.UUID, str]]:
        states_tuple = tuple(states)
        stmt = (
            select(MergeQueueEntry.repo_id, MergeQueueEntry.integration_branch)
            .where(MergeQueueEntry.state.in_(states_tuple))
            .distinct()
        )
        result = await self.db.execute(stmt)
        return [(row[0], row[1]) for row in result.all()]

    async def claim_stale_notification(
        self, entry_id: uuid.UUID, *, now: datetime
    ) -> bool:
        """Stamp the stale latch, returning whether THIS caller won the claim.

        The IS NULL predicate makes the transition single-fire: concurrent
        board-health polls (several Cloud Run instances, one row) race on the
        same UPDATE and exactly one reports rowcount 1.
        """
        stmt = (
            update(MergeQueueEntry)
            .where(MergeQueueEntry.id == entry_id)
            .where(MergeQueueEntry.stale_notified_at.is_(None))
            .values(stale_notified_at=now)
        )
        result = await self.db.execute(stmt)
        await self.db.flush()
        return result.rowcount == 1

    async def cancel(self, entry_id: uuid.UUID) -> None:
        entry = await self.get(entry_id)
        if entry is None:
            return
        await self.db.delete(entry)
        await self.db.flush()

    async def _require(self, entry_id: uuid.UUID) -> MergeQueueEntry:
        entry = await self.get(entry_id)
        if entry is None:
            raise LookupError(f"merge_queue_entry {entry_id} not found")
        return entry
