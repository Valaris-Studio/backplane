# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add webhooks table

Revision ID: 015
Revises: 014
Create Date: 2026-04-10
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "webhooks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "workspace_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("events", sa.JSON, nullable=False),
        sa.Column("secret", sa.String(255), nullable=False),
        sa.Column(
            "is_active",
            sa.Boolean,
            nullable=False,
            server_default="true",
        ),
        sa.Column("last_delivered_at", sa.DateTime, nullable=True),
        sa.Column(
            "failure_count",
            sa.Integer,
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_by_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    op.create_index("ix_webhooks_workspace", "webhooks", ["workspace_id"])
    op.create_index("ix_webhooks_active", "webhooks", ["is_active"])


def downgrade() -> None:
    op.drop_index("ix_webhooks_active", table_name="webhooks")
    op.drop_index("ix_webhooks_workspace", table_name="webhooks")
    op.drop_table("webhooks")
