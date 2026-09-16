# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Durable exact-revision completion candidates and leased independent attempts."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "106"
down_revision = "105"
branch_labels = None
depends_on = None


def ref(name, table, *, nullable=False, ondelete=None):
    return sa.Column(
        name,
        postgresql.UUID(as_uuid=True),
        sa.ForeignKey(table + ".id", ondelete=ondelete),
        nullable=nullable,
    )


def identity_columns():
    return [
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "created_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(), nullable=False, server_default=sa.func.now()
        ),
    ]


def upgrade():
    op.create_table(
        "completion_candidates",
        *identity_columns(),
        ref("workspace_id", "workspaces", ondelete="CASCADE"),
        ref("board_id", "boards", ondelete="CASCADE"),
        ref("card_id", "cards", ondelete="CASCADE"),
        sa.Column("is_current", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("completion_mode", sa.String(20), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        ref("source_execution_id", "agent_executions"),
        ref("source_agent_id", "agents"),
        ref("submitted_by", "users"),
        ref("repo_id", "git_repos", nullable=True, ondelete="SET NULL"),
        sa.Column("repo_url", sa.String(1000), nullable=False),
        sa.Column("source_sha", sa.String(64), nullable=False),
        sa.Column("merge_sha", sa.String(64)),
        sa.Column("pr_url", sa.String(1000)),
        sa.Column("branch", sa.String(255)),
        sa.Column("target_branch", sa.String(255)),
        sa.Column("card_hash", sa.String(64), nullable=False),
        sa.Column("policy_hash", sa.String(64), nullable=False),
        sa.Column("contract_hash", sa.String(64), nullable=False),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("policy", sa.JSON(), nullable=False),
        sa.Column("artifacts", sa.JSON(), nullable=False),
        sa.Column("checks", sa.JSON(), nullable=False),
        sa.Column(
            "review_passed", sa.Boolean(), nullable=False, server_default="false"
        ),
        sa.Column("failed_kind", sa.String(32)),
        sa.Column("summary", sa.Text()),
        sa.Column("accepted_at", sa.DateTime()),
    )
    for column in ("workspace_id", "board_id", "card_id", "status"):
        op.create_index(
            "ix_completion_candidates_" + column, "completion_candidates", [column]
        )
    op.create_index(
        "uq_completion_current_card",
        "completion_candidates",
        ["card_id"],
        unique=True,
        postgresql_where=sa.text("is_current = true"),
        sqlite_where=sa.text("is_current = 1"),
    )
    op.create_table(
        "completion_attempts",
        *identity_columns(),
        ref("candidate_id", "completion_candidates", ondelete="CASCADE"),
        ref("workspace_id", "workspaces", ondelete="CASCADE"),
        ref("board_id", "boards", ondelete="CASCADE"),
        ref("execution_id", "agent_executions"),
        ref("agent_id", "agents"),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("role", sa.String(64), nullable=False),
        sa.Column("provider", sa.String(50), nullable=False),
        sa.Column("model", sa.String(100), nullable=False),
        sa.Column("source_sha", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False, server_default="claimed"),
        sa.Column("context_hash", sa.String(64), nullable=True),
        sa.Column("lease_hash", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("result_hash", sa.String(64)),
        sa.Column("result", sa.JSON()),
        sa.Column("completed_at", sa.DateTime()),
        sa.UniqueConstraint("execution_id"),
    )
    for column in ("candidate_id", "workspace_id", "board_id"):
        op.create_index(
            "ix_completion_attempts_" + column, "completion_attempts", [column]
        )
    op.create_index(
        "uq_completion_claimed_candidate",
        "completion_attempts",
        ["candidate_id"],
        unique=True,
        postgresql_where=sa.text("status = 'claimed'"),
        sqlite_where=sa.text("status = 'claimed'"),
    )
    if op.get_bind().dialect.name == "postgresql":
        op.alter_column(
            "agent_prompt_configs", "team_role", existing_type=sa.String(20),
            type_=sa.String(64), existing_nullable=True,
        )
        op.alter_column(
            "agent_executions",
            "role",
            existing_type=sa.String(20),
            type_=sa.String(64),
            existing_nullable=True,
        )


def downgrade():
    op.drop_table("completion_attempts")
    op.drop_table("completion_candidates")
    # Role widening stays: narrowing would destroy valid operator-defined roles.
