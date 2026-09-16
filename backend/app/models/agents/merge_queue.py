# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin

# Closed enum mirrored in the migration's CHECK constraint. Adding a new state
# is a two-step deploy: ship the enum first, ship the writer second.
# PAR-3a added 'blocked_pending_consolidation' (PAR-3b parks entries here while
# the conflict-resolution consolidator card is being worked).
_MERGE_QUEUE_STATES = frozenset(
    {
        "queued",
        "merging",
        "merged",
        "conflict",
        "failed",
        "blocked_pending_consolidation",
    }
)


class MergeQueueEntry(Base, UUIDMixin):
    """Backend-owned merge queue keyed by (repo_id, integration_branch).

    PAR-2: replaces the runner-owned mergeGate. Reviewer-approve enqueues
    one of these; a backend worker pops and merges. SELECT FOR UPDATE
    SKIP LOCKED gives per-(repo, branch) serialization across replicas
    without a separate distributed lock.
    """

    __tablename__ = "merge_queue_entries"
    __table_args__ = (
        UniqueConstraint("card_id", name="uq_merge_queue_entries_card"),
        CheckConstraint(
            "state IN ('queued','merging','merged','conflict','failed',"
            "'blocked_pending_consolidation')",
            name="ck_merge_queue_entries_state",
        ),
        Index(
            "ix_merge_queue_repo_branch_state",
            "repo_id",
            "integration_branch",
            "state",
        ),
    )

    repo_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("git_repos.id", ondelete="CASCADE"),
        index=True,
    )
    integration_branch: Mapped[str] = mapped_column(String(255))
    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("cards.id", ondelete="CASCADE"),
        index=True,
    )
    pr_url: Mapped[str] = mapped_column(Text)
    pr_branch: Mapped[str] = mapped_column(String(255))
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        index=True,
    )
    # FIFO position. re_enqueue bumps this to the back of the queue on every
    # retry so a churning entry cannot starve fresh ones behind it.
    enqueued_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now()
    )
    # When the entry FIRST entered the queue — never bumped by a retry. This is
    # what staleness is measured from; using enqueued_at made hot retry loops
    # invisible to the stale detector (migration 088). NULL = written before
    # that migration; readers fall back to enqueued_at.
    first_enqueued_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
    state: Mapped[str] = mapped_column(String(32), default="queued")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    merged_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # NULL = the operator has never been notified this entry went stale. The
    # once-per-crossing latch for merge_queue.stale (migration 085); board
    # health polls are stateless, so the "already told them" bit must persist.
    stale_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime, nullable=True
    )
