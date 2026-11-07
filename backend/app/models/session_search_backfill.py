# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The bounded historical backfill of the session search index.

A run is one verification epoch of the retained-session lane: its identity
(scope, extractor, effective store) never changes, and at most one run of the
lane is unfinished. A worker owns the run through a lease (an epoch and an
expiry compared on the database clock) and walks finite UUID-bounded scans of
each source kind. Claims are the run's at most 25 durable pieces of work. They
hang off their run alone and carry identity, digest and size facts only, never
a body, storage key, query or label. A due claim settles as absent when its
source is gone. Exhausted claims stay frozen until a successor run, including
when the source is later deleted or its descriptor changes."""

import uuid
from datetime import datetime

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    false,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, UUIDMixin

BACKFILL_LANE = "retained_session_search"
BACKFILL_SCOPES = ("all_workspaces",)
FINISH_REASONS = (
    "clean_observation",
    "claims_exhausted",
    "unresolved_metadata",
    "superseded",
)


class SessionSearchBackfillRun(Base, UUIDMixin):
    __tablename__ = "session_search_backfill_runs"
    __table_args__ = (
        Index(
            "uq_session_search_backfill_active_lane",
            "lane",
            unique=True,
            postgresql_where=text("finished_at IS NULL"),
            sqlite_where=text("finished_at IS NULL"),
        ),
        CheckConstraint(
            "lane = 'retained_session_search'", name="ck_session_search_backfill_lane"
        ),
        CheckConstraint(
            "scope IN ('all_workspaces')", name="ck_session_search_backfill_scope"
        ),
        CheckConstraint(
            "phase IN ('verify_unavailable', 'discover', 'reconcile', 'finished', "
            "'superseded')",
            name="ck_session_search_backfill_phase",
        ),
        CheckConstraint(
            "finish_reason IS NULL OR finish_reason IN ('clean_observation', "
            "'claims_exhausted', 'unresolved_metadata', 'superseded')",
            name="ck_session_search_backfill_finish_reason",
        ),
    )

    lane: Mapped[str] = mapped_column(String(32), default=BACKFILL_LANE)
    scope: Mapped[str] = mapped_column(String(32))
    extractor_version: Mapped[str] = mapped_column(String(64))
    # SHA-256 of a versioned encoding of the resolved store location; the
    # location itself is never stored.
    store_fingerprint: Mapped[str] = mapped_column(CHAR(64))
    phase: Mapped[str] = mapped_column(String(24))
    # 0 while discovering; each reconciliation sweep after it adds one.
    sweep: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # Each kind's scan visits ids after `cursor` up to the `upper` it captured
    # when the sweep began.
    content_cursor: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    content_upper: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    content_exhausted: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    event_cursor: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    event_upper: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    event_exhausted: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false()
    )
    lease_epoch: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    finish_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
    # The run created after this one; no foreign key, so either can go alone.
    superseded_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    # Fixed keys only: committed outcome counts and observed verification.
    counters: Mapped[dict] = mapped_column(
        JSON, default=dict, server_default=text("'{}'")
    )
    verification_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    verification_finished_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SessionSearchBackfillClaim(Base):
    __tablename__ = "session_search_backfill_claims"
    __table_args__ = (
        CheckConstraint(
            "source_kind IN ('content', 'event')",
            name="ck_session_search_backfill_claim_kind",
        ),
        CheckConstraint(
            "state IN ('pending', 'retry_wait', 'exhausted')",
            name="ck_session_search_backfill_claim_state",
        ),
        CheckConstraint(
            "reason IS NULL OR reason IN ('storage_unavailable', 'stale', "
            "'budget_deferred')",
            name="ck_session_search_backfill_claim_reason",
        ),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("session_search_backfill_runs.id", ondelete="CASCADE"),
        primary_key=True,
    )
    source_kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    # No foreign key: deletion is observed, never cascaded into a claim.
    source_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    expected_digest: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)
    descriptor_fingerprint: Mapped[str] = mapped_column(CHAR(64))
    reserved_bytes: Mapped[int] = mapped_column(
        BigInteger, default=0, server_default="0"
    )
    # Storage failures of the claim's current identity.
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    next_attempt_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    state: Mapped[str] = mapped_column(String(16), default="pending")
    reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
