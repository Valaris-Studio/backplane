# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add alert thresholds

Revision ID: 016
Revises: 015
Create Date: 2026-04-10

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "alert_thresholds",
        sa.Column("id", UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("workspace_id", UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", UUID(as_uuid=True), nullable=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("metric", sa.Enum("health_score", "stale_card_count", "overdue_card_count", "agent_efficiency", "reversion_rate", "handoff_friction", name="alertmetric"), nullable=False),
        sa.Column("operator", sa.Enum("gt", "gte", "lt", "lte", "eq", name="alertoperator"), nullable=False),
        sa.Column("value", sa.Float(), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_by_id", UUID(as_uuid=True), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"]),
    )
    op.create_index("ix_alert_thresholds_workspace", "alert_thresholds", ["workspace_id"])
    op.create_index("ix_alert_thresholds_board", "alert_thresholds", ["board_id"])


def downgrade() -> None:
    op.drop_index("ix_alert_thresholds_board", table_name="alert_thresholds")
    op.drop_index("ix_alert_thresholds_workspace", table_name="alert_thresholds")
    op.drop_table("alert_thresholds")
    op.execute("DROP TYPE IF EXISTS alertmetric")
    op.execute("DROP TYPE IF EXISTS alertoperator")
