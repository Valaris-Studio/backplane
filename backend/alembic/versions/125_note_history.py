# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exact note revisions with per-note shared byte chunks.

Additive for rolling deployment: old writers keep using notes, and leave the
counter unchanged. New writers detect that state drift before recording edits.
No pre-feature history is synthesized by this migration.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "125"
down_revision = "124"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "notes",
        sa.Column("history_revision", sa.Integer(), nullable=False, server_default="0"),
    )
    op.create_table(
        "note_revisions",
        sa.Column("note_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("capture_kind", sa.String(32), nullable=False),
        sa.Column("operation", sa.String(32), nullable=False),
        sa.Column("changed_fields", sa.JSON(), nullable=False),
        sa.Column("content_bytes", sa.BigInteger(), nullable=False),
        sa.Column("content_sha256", sa.CHAR(64), nullable=False),
        sa.Column("revision_digest", sa.CHAR(64), nullable=False),
        sa.Column("storage_version", sa.SmallInteger(), nullable=False, server_default="1"),
        sa.Column("chunk_count", sa.Integer(), nullable=False),
        sa.Column("title", sa.String(500), nullable=False),
        sa.Column("pinned", sa.Boolean(), nullable=False),
        sa.Column("card_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("source_execution_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("failure_class", sa.String(32), nullable=True),
        sa.Column("findings", sa.JSON(), nullable=True),
        sa.Column("actor", sa.JSON(), nullable=True),
        sa.Column("invocation_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("note_id", "revision"),
        sa.CheckConstraint("revision > 0", name="ck_note_revisions_sequence"),
        sa.CheckConstraint("content_bytes >= 0", name="ck_note_revisions_content_bytes"),
        sa.CheckConstraint("chunk_count >= 0", name="ck_note_revisions_chunk_count"),
    )
    op.create_table(
        "note_revision_chunks",
        sa.Column("note_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("sha256", sa.CHAR(64), nullable=False),
        sa.Column("content_bytes", sa.Integer(), nullable=False),
        sa.Column("payload", sa.LargeBinary(), nullable=False),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("note_id", "sha256"),
        sa.CheckConstraint(
            "content_bytes > 0 AND content_bytes <= 16384",
            name="ck_note_revision_chunks_size",
        ),
    )
    op.create_table(
        "note_revision_manifest",
        sa.Column("note_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("sha256", sa.CHAR(64), nullable=False),
        sa.PrimaryKeyConstraint("note_id", "revision", "position"),
        sa.ForeignKeyConstraint(
            ["note_id", "revision"],
            ["note_revisions.note_id", "note_revisions.revision"],
            ondelete="CASCADE",
            name="fk_note_revision_manifest_revision",
        ),
        sa.ForeignKeyConstraint(
            ["note_id", "sha256"],
            ["note_revision_chunks.note_id", "note_revision_chunks.sha256"],
            ondelete="CASCADE",
            name="fk_note_revision_manifest_chunk",
        ),
        sa.CheckConstraint("position >= 0", name="ck_note_revision_manifest_position"),
    )
    # Chunk cascades must not scan every revision's unrelated references.
    op.create_index(
        "ix_note_revision_manifest_note_chunk", "note_revision_manifest", ["note_id", "sha256"]
    )
    op.create_table(
        "note_mutation_receipts",
        sa.Column("note_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("principal_key", sa.String(256), nullable=False),
        sa.Column("client_request_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("fingerprint", sa.CHAR(64), nullable=False),
        sa.Column("applied_revision", sa.Integer(), nullable=True),
        sa.Column("changed", sa.Boolean(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.PrimaryKeyConstraint("note_id", "principal_key", "client_request_id"),
        sa.ForeignKeyConstraint(["note_id"], ["notes.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["note_id", "applied_revision"],
            ["note_revisions.note_id", "note_revisions.revision"],
            ondelete="CASCADE",
            name="fk_note_mutation_receipts_revision",
        ),
    )


def downgrade():
    op.drop_table("note_mutation_receipts")
    op.drop_table("note_revision_manifest")
    op.drop_table("note_revision_chunks")
    op.drop_table("note_revisions")
    op.drop_column("notes", "history_revision")
