# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Retry receipts for note saves: one row per (person, client_request_id).

Additive and rolling-safe: a new table only, which the previous release never
reads. Deleting a note sets its receipt's note_id NULL (the tombstone) and is
never blocked by it."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "120"
down_revision = "119"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "note_save_receipts",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_request_id", UUID(as_uuid=True), nullable=False),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "board_id",
            UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "card_id",
            UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("fingerprint", sa.CHAR(64), nullable=False),
        sa.Column(
            "note_id",
            UUID(as_uuid=True),
            sa.ForeignKey("notes.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "user_id", "client_request_id", name="uq_note_save_receipts_request"
        ),
    )
    op.create_index(
        "ix_note_save_receipts_workspace_id", "note_save_receipts", ["workspace_id"]
    )
    op.create_index("ix_note_save_receipts_note_id", "note_save_receipts", ["note_id"])


def downgrade():
    op.drop_index("ix_note_save_receipts_note_id", table_name="note_save_receipts")
    op.drop_index("ix_note_save_receipts_workspace_id", table_name="note_save_receipts")
    op.drop_table("note_save_receipts")
