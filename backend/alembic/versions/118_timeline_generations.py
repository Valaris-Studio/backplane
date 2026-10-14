# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Frozen timeline visibility and resumable forward reconstruction."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "118"
down_revision = "117"
branch_labels = None
depends_on = None


def upgrade():
    if op.get_bind().dialect.name == "postgresql":
        # Separate statements preserve NULL on pre-migration activity. The table
        # lock also drains existing writers before the new default takes effect.
        op.execute("ALTER TABLE activities ADD COLUMN recorded_transaction xid8 NULL")
        op.execute(
            "ALTER TABLE activities ALTER COLUMN recorded_transaction SET DEFAULT pg_current_xact_id()"
        )
    else:
        op.add_column(
            "activities", sa.Column("recorded_transaction", sa.String(), nullable=True)
        )
    op.create_table(
        "timeline_generations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
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
        sa.Column("request_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("first_seq", sa.BigInteger()),
        sa.Column("head_seq", sa.BigInteger()),
        sa.Column("event_count", sa.BigInteger(), nullable=False),
        sa.Column("first_at", sa.DateTime(timezone=True)),
        sa.Column("last_at", sa.DateTime(timezone=True)),
        sa.Column("source_snapshot", sa.Text(), nullable=False),
        sa.Column("actor_labels", sa.JSON(), nullable=False),
        sa.Column("observed_state", sa.JSON(), nullable=False),
        sa.Column("known_empty_genesis", sa.Boolean(), nullable=False),
        sa.Column("schema_version", sa.Integer(), nullable=False),
        sa.Column("cursor_secret", sa.String(64), nullable=False),
        sa.UniqueConstraint(
            "board_id", "request_id", name="uq_timeline_generation_request"
        ),
    )
    for field in ("workspace_id", "board_id", "expires_at"):
        op.create_index(
            f"ix_timeline_generations_{field}", "timeline_generations", [field]
        )
    op.create_table(
        "timeline_checkpoints",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "generation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("timeline_generations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("through_seq", sa.BigInteger(), nullable=False),
        sa.Column("processed_events", sa.BigInteger(), nullable=False),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("coverage", sa.JSON(), nullable=False),
        sa.UniqueConstraint(
            "generation_id", "through_seq", name="uq_timeline_checkpoint_boundary"
        ),
    )
    op.create_index(
        "ix_timeline_checkpoints_generation_id",
        "timeline_checkpoints",
        ["generation_id"],
    )
    op.create_table(
        "timeline_preparations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "generation_id",
            UUID(as_uuid=True),
            sa.ForeignKey("timeline_generations.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "requested_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("agent_id", UUID(as_uuid=True)),
        sa.Column("target_seq", sa.BigInteger(), nullable=False),
        sa.Column("through_seq", sa.BigInteger(), nullable=False),
        sa.Column("processed_events", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("retryable", sa.Boolean(), nullable=False),
        sa.Column("error", sa.JSON()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint(
            "generation_id", "target_seq", name="uq_timeline_preparation_target"
        ),
    )
    op.create_index(
        "ix_timeline_preparations_generation_id",
        "timeline_preparations",
        ["generation_id"],
    )
    op.create_index(
        "ix_timeline_preparation_status",
        "timeline_preparations",
        ["status", "updated_at"],
    )


def downgrade():
    op.drop_table("timeline_preparations")
    op.drop_table("timeline_checkpoints")
    op.drop_table("timeline_generations")
    op.drop_column("activities", "recorded_transaction")
