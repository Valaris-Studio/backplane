# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add input_prompt to agent_executions

Revision ID: 034
Revises: 033
Create Date: 2026-04-15

"""

from alembic import op
import sqlalchemy as sa

revision = "034"
down_revision = "033"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_executions",
        sa.Column("input_prompt", sa.Text(), nullable=True),
    )


def downgrade():
    op.drop_column("agent_executions", "input_prompt")
