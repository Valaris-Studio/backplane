# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add merge_queue_entries

PAR-2: backend-owned merge queue table. Keyed by (repo_id, integration_branch);
the worker pops entries with SELECT FOR UPDATE SKIP LOCKED for per-key
serialization. UNIQUE(card_id) makes enqueue idempotent — re-enqueue of the
same card returns the existing row instead of inserting a duplicate.

Adding tables is always rolling-deploy safe.

Revision ID: 053
Revises: 052
Create Date: 2026-04-25
"""

import sqlalchemy as sa
from alembic import op

revision = "053"
down_revision = "052"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "merge_queue_entries",
        sa.Column(
            "id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column(
            "repo_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("git_repos.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("integration_branch", sa.String(length=255), nullable=False),
        sa.Column(
            "card_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("pr_url", sa.Text, nullable=False),
        sa.Column("pr_branch", sa.String(length=255), nullable=False),
        sa.Column(
            "workspace_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "enqueued_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "state",
            sa.String(length=32),
            nullable=False,
            server_default="queued",
        ),
        sa.Column(
            "attempt_count", sa.Integer, nullable=False, server_default="0"
        ),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("merged_at", sa.DateTime, nullable=True),
        sa.UniqueConstraint("card_id", name="uq_merge_queue_entries_card"),
        sa.CheckConstraint(
            "state IN ('queued','merging','merged','conflict','failed')",
            name="ck_merge_queue_entries_state",
        ),
    )
    op.create_index(
        "ix_merge_queue_repo_branch_state",
        "merge_queue_entries",
        ["repo_id", "integration_branch", "state"],
    )
    op.create_index(
        "ix_merge_queue_entries_repo_id", "merge_queue_entries", ["repo_id"]
    )
    op.create_index(
        "ix_merge_queue_entries_card_id", "merge_queue_entries", ["card_id"]
    )
    op.create_index(
        "ix_merge_queue_entries_workspace_id",
        "merge_queue_entries",
        ["workspace_id"],
    )


def downgrade():
    op.drop_index(
        "ix_merge_queue_entries_workspace_id",
        table_name="merge_queue_entries",
    )
    op.drop_index(
        "ix_merge_queue_entries_card_id", table_name="merge_queue_entries"
    )
    op.drop_index(
        "ix_merge_queue_entries_repo_id", table_name="merge_queue_entries"
    )
    op.drop_index(
        "ix_merge_queue_repo_branch_state",
        table_name="merge_queue_entries",
    )
    op.drop_table("merge_queue_entries")
