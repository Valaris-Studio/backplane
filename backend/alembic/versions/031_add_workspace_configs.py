# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add workspace_configs table

Revision ID: 031
Revises: 030
Create Date: 2026-04-14

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "031"
down_revision = "030"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "workspace_configs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            unique=True,
            index=True,
            nullable=False,
        ),
        sa.Column(
            "max_rework_attempts",
            sa.Integer,
            nullable=False,
            server_default="3",
        ),
        sa.Column(
            "card_cooldown_hours",
            sa.Float,
            nullable=False,
            server_default="1.0",
        ),
        sa.Column(
            "commit_message_template",
            sa.String(500),
            nullable=False,
            server_default="feat({{.CardID}}): {{.Title}}",
        ),
        sa.Column(
            "pr_description_template",
            sa.Text,
            nullable=False,
            server_default="",
        ),
        sa.Column("model_pricing", postgresql.JSON, nullable=True),
        sa.Column("version", sa.Integer, nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime, server_default=sa.func.now(), onupdate=sa.func.now()),
    )


def downgrade():
    op.drop_table("workspace_configs")
