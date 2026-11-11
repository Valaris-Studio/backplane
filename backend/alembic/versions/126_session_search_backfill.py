# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Runs and claims of the bounded historical session search backfill.

Additive and rolling-safe: two new tables that no earlier release reads; the
previous release keeps indexing new content exactly as before. At most one
run of the lane is unfinished (a partial unique index). Claims cascade from
their run only and carry no body, storage key, query or label. Downgrading
drops both tables; the search index rows the runs wrote stay valid on their
own, and the session search keeps reporting what is still pending."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "126"
down_revision = "125"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "session_search_backfill_runs",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("lane", sa.String(32), nullable=False),
        sa.Column("scope", sa.String(32), nullable=False),
        sa.Column("extractor_version", sa.String(64), nullable=False),
        sa.Column("store_fingerprint", sa.CHAR(64), nullable=False),
        sa.Column("phase", sa.String(24), nullable=False),
        sa.Column("sweep", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("content_cursor", UUID(as_uuid=True), nullable=True),
        sa.Column("content_upper", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "content_exhausted", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("event_cursor", UUID(as_uuid=True), nullable=True),
        sa.Column("event_upper", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "event_exhausted", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
        sa.Column("lease_epoch", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finish_reason", sa.String(32), nullable=True),
        sa.Column("superseded_by", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "counters", sa.JSON(), nullable=False, server_default=sa.text("'{}'")
        ),
        sa.Column("verification_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "verification_finished_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.CheckConstraint(
            "lane = 'retained_session_search'", name="ck_session_search_backfill_lane"
        ),
        sa.CheckConstraint(
            "scope IN ('all_workspaces')", name="ck_session_search_backfill_scope"
        ),
        sa.CheckConstraint(
            "phase IN ('verify_unavailable', 'discover', 'reconcile', 'finished', "
            "'superseded')",
            name="ck_session_search_backfill_phase",
        ),
        sa.CheckConstraint(
            "finish_reason IS NULL OR finish_reason IN ('clean_observation', "
            "'claims_exhausted', 'unresolved_metadata', 'superseded')",
            name="ck_session_search_backfill_finish_reason",
        ),
    )
    op.create_index(
        "uq_session_search_backfill_active_lane",
        "session_search_backfill_runs",
        ["lane"],
        unique=True,
        postgresql_where=sa.text("finished_at IS NULL"),
        sqlite_where=sa.text("finished_at IS NULL"),
    )
    op.create_table(
        "session_search_backfill_claims",
        sa.Column(
            "run_id",
            UUID(as_uuid=True),
            sa.ForeignKey("session_search_backfill_runs.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("source_kind", sa.String(8), primary_key=True),
        sa.Column("source_id", UUID(as_uuid=True), primary_key=True),
        sa.Column("expected_digest", sa.CHAR(64), nullable=True),
        sa.Column("descriptor_fingerprint", sa.CHAR(64), nullable=False),
        sa.Column(
            "reserved_bytes", sa.BigInteger(), nullable=False, server_default="0"
        ),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("next_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("state", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(32), nullable=True),
        sa.CheckConstraint(
            "source_kind IN ('content', 'event')",
            name="ck_session_search_backfill_claim_kind",
        ),
        sa.CheckConstraint(
            "state IN ('pending', 'retry_wait', 'exhausted')",
            name="ck_session_search_backfill_claim_state",
        ),
        sa.CheckConstraint(
            "reason IS NULL OR reason IN ('storage_unavailable', 'stale', "
            "'budget_deferred')",
            name="ck_session_search_backfill_claim_reason",
        ),
    )


def downgrade():
    op.drop_table("session_search_backfill_claims")
    op.drop_index(
        "uq_session_search_backfill_active_lane",
        table_name="session_search_backfill_runs",
    )
    op.drop_table("session_search_backfill_runs")
