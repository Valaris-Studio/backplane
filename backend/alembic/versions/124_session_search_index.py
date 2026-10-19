# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The owner-private session search index: per-session generations, one row
per indexed content item or event, and their folded text chunks.

Additive and rolling-safe: new tables only, which the previous release never
reads. While it still runs, the sources it stores have no index row; search
reports them pending (coverage compares retained sources with these rows),
never as searched. Every row cascades from its session, and a source and its
chunks also from their content item or event, so existing deletion paths
remove the searchable copies without code of their own. Downgrading drops
the index only; retained sessions are untouched."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "124"
down_revision = "123"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "session_search_states",
        sa.Column(
            "session_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("generation", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_table(
        "session_search_sources",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "content_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_session_contents.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "event_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_session_events.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(32), nullable=True),
        sa.Column("extractor_version", sa.String(64), nullable=False),
        sa.Column("source_digest", sa.CHAR(64), nullable=False),
        sa.Column("byte_count", sa.BigInteger(), nullable=True),
        sa.Column("folded_bytes", sa.BigInteger(), nullable=False, server_default="0"),
        sa.Column("chunk_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("call_anchor", sa.String(220), nullable=True),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("content_id", name="uq_session_search_source_content"),
        sa.UniqueConstraint("event_id", name="uq_session_search_source_event"),
        sa.CheckConstraint(
            "(content_id IS NULL) <> (event_id IS NULL)",
            name="ck_session_search_source_kind",
        ),
        sa.CheckConstraint(
            "status IN ('pending', 'indexed', 'unavailable', 'not_text')",
            name="ck_session_search_source_status",
        ),
    )
    op.create_index(
        "ix_session_search_sources_session",
        "session_search_sources",
        ["session_id", "status"],
    )
    op.create_table(
        "session_search_chunks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "session_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_id",
            UUID(as_uuid=True),
            sa.ForeignKey("session_search_sources.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sort_us", sa.BigInteger(), nullable=False),
        sa.Column("sort_order", sa.BigInteger(), nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("field", sa.Text(), nullable=False),
        sa.Column("channel", sa.String(32), nullable=True),
        sa.Column("segment_byte_start", sa.BigInteger(), nullable=False),
        sa.Column("segment_byte_end", sa.BigInteger(), nullable=False),
        sa.Column("byte_start", sa.BigInteger(), nullable=False),
        sa.Column("owned_chars", sa.Integer(), nullable=False),
        sa.Column("owned_bytes", sa.Integer(), nullable=False),
        sa.Column("folded_text", sa.Text(), nullable=False),
        sa.Column("case_map", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_session_search_chunks_scan",
        "session_search_chunks",
        ["session_id", "sort_us", "sort_order", "source_id", "ordinal"],
    )
    op.create_index(
        "ix_session_search_chunks_source_id", "session_search_chunks", ["source_id"]
    )


def downgrade():
    op.drop_index(
        "ix_session_search_chunks_source_id", table_name="session_search_chunks"
    )
    op.drop_index("ix_session_search_chunks_scan", table_name="session_search_chunks")
    op.drop_table("session_search_chunks")
    op.drop_index(
        "ix_session_search_sources_session", table_name="session_search_sources"
    )
    op.drop_table("session_search_sources")
    op.drop_table("session_search_states")
