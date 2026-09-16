# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add tool_invocations table for per-tool execution tracking

Revision ID: 024
Revises: 023
Create Date: 2026-04-12
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "024"
down_revision = "023"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "tool_invocations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("execution_id", UUID(as_uuid=True), sa.ForeignKey("agent_executions.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("tool_name", sa.String(255), nullable=False),
        sa.Column("arguments_summary", sa.Text, server_default=""),
        sa.Column("result_summary", sa.Text, nullable=True),
        sa.Column("started_at", sa.DateTime, server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime, nullable=True),
        sa.Column("duration_seconds", sa.Float, nullable=True),
        sa.Column("status", sa.String(20), server_default="started"),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("position", sa.Integer, server_default="0"),
    )


def downgrade():
    op.drop_table("tool_invocations")
