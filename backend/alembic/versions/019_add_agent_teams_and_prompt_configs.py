# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add agent teams and prompt configs

Revision ID: 019
Revises: 018
Create Date: 2026-04-11

"""
import sqlalchemy as sa
from alembic import op

revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_teams",
        sa.Column("id", sa.Uuid(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text(), server_default="", nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False),
        sa.Column("board_id", sa.Uuid(), sa.ForeignKey("boards.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_by_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_teams_workspace_id", "agent_teams", ["workspace_id"])
    op.create_index("ix_agent_teams_board_id", "agent_teams", ["board_id"])

    op.create_table(
        "agent_team_members",
        sa.Column("team_id", sa.Uuid(), sa.ForeignKey("agent_teams.id", ondelete="CASCADE"), nullable=False),
        sa.Column("agent_id", sa.Uuid(), sa.ForeignKey("agents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("added_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("team_id", "agent_id"),
    )

    op.create_table(
        "agent_prompt_configs",
        sa.Column("id", sa.Uuid(), nullable=False, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("slug", sa.String(255), nullable=False),
        sa.Column("agent_type", sa.String(20), nullable=True),
        sa.Column("team_role", sa.String(20), nullable=True),
        sa.Column("stage", sa.String(100), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_system", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("workspace_id", sa.Uuid(), sa.ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=True),
        sa.Column("version", sa.Integer(), server_default="1", nullable=False),
        sa.Column("created_by_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()"), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_prompt_configs_slug", "agent_prompt_configs", ["slug"])

    op.add_column(
        "agent_executions",
        sa.Column(
            "parent_execution_id",
            sa.Uuid(),
            sa.ForeignKey("agent_executions.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "agent_executions",
        sa.Column(
            "prompt_config_id",
            sa.Uuid(),
            sa.ForeignKey("agent_prompt_configs.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("agent_executions", "prompt_config_id")
    op.drop_column("agent_executions", "parent_execution_id")
    op.drop_index("ix_agent_prompt_configs_slug", table_name="agent_prompt_configs")
    op.drop_table("agent_prompt_configs")
    op.drop_table("agent_team_members")
    op.drop_index("ix_agent_teams_board_id", table_name="agent_teams")
    op.drop_index("ix_agent_teams_workspace_id", table_name="agent_teams")
    op.drop_table("agent_teams")
