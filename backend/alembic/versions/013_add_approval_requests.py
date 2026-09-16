# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add approval_requests table

Revision ID: 013
Revises: 012
Create Date: 2026-04-10
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "approval_requests",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("workspace_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("board_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "category",
            sa.Enum(
                "deletion", "bulk_change", "deployment",
                "schema_change", "permission_change", "external_action",
                name="approvalcategory",
            ),
            nullable=False,
        ),
        sa.Column("action_description", sa.Text(), nullable=False),
        sa.Column("action_payload", sa.JSON(), server_default="{}", nullable=False),
        sa.Column("risk_score", sa.Integer(), server_default="0", nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending", "approved", "rejected", "expired", "auto_approved",
                name="approvalstatus",
            ),
            server_default="pending",
            nullable=False,
        ),
        sa.Column("decided_by_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("decided_at", sa.DateTime(), nullable=True),
        sa.Column("decision_reason", sa.Text(), nullable=True),
        sa.Column(
            "expires_at",
            sa.DateTime(),
            server_default=sa.text("now() + interval '24 hours'"),
            nullable=False,
        ),
        sa.Column("execution_id", postgresql.UUID(as_uuid=True), nullable=True),
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
        sa.ForeignKeyConstraint(["agent_id"], ["agents.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["decided_by_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_approval_requests_agent_id", "approval_requests", ["agent_id"])
    op.create_index("ix_approval_requests_workspace_id", "approval_requests", ["workspace_id"])
    op.create_index("ix_approval_requests_status", "approval_requests", ["status"])


def downgrade() -> None:
    op.drop_table("approval_requests")
    op.execute("DROP TYPE IF EXISTS approvalstatus")
    op.execute("DROP TYPE IF EXISTS approvalcategory")
