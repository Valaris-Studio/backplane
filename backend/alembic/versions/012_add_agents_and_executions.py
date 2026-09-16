# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add agents and agent_executions tables

Revision ID: 012
Revises: 011
Create Date: 2026-04-10
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column(
            "agent_type",
            sa.Enum("coding", "manager", "reviewer", "secretary", "improver", name="agenttype"),
            nullable=False,
        ),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("api_key_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("allowed_workspaces", sa.JSON(), nullable=True),
        sa.Column("allowed_actions", sa.JSON(), nullable=True),
        sa.Column("max_requests_per_minute", sa.Integer(), server_default="100", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["api_key_id"], ["api_keys.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.create_table(
        "agent_executions",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("session_id", sa.String(255), nullable=True),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(255), nullable=False),
        sa.Column(
            "status",
            sa.Enum("started", "running", "completed", "failed", "aborted", name="executionstatus"),
            nullable=False,
        ),
        sa.Column(
            "started_at",
            sa.DateTime(),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("completed_at", sa.DateTime(), nullable=True),
        sa.Column("input_summary", sa.Text(), server_default="", nullable=False),
        sa.Column("output_summary", sa.Text(), nullable=True),
        sa.Column("tools_used", sa.JSON(), nullable=True),
        sa.Column("cards_affected", sa.JSON(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("tool_calls_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("tokens_used", sa.Integer(), nullable=True),
        sa.Column("duration_seconds", sa.Float(), nullable=True),
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_executions_agent_id", "agent_executions", ["agent_id"])
    op.create_index("ix_agent_executions_workspace_id", "agent_executions", ["workspace_id"])


def downgrade() -> None:
    op.drop_table("agent_executions")
    op.drop_table("agents")
    op.execute("DROP TYPE IF EXISTS executionstatus")
    op.execute("DROP TYPE IF EXISTS agenttype")
