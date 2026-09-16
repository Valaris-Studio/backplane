# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add team_id to agent_prompt_configs

Revision ID: 026
Revises: 025
Create Date: 2026-04-12
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "026"
down_revision = "025"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_prompt_configs",
        sa.Column(
            "team_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agent_teams.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade():
    op.drop_column("agent_prompt_configs", "team_id")
