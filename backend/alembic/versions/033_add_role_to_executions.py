# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add role to agent_executions

Revision ID: 033
Revises: 032
Create Date: 2026-04-15

"""

from alembic import op
import sqlalchemy as sa

revision = "033"
down_revision = "032"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_executions",
        sa.Column("role", sa.String(20), nullable=True),
    )


def downgrade():
    op.drop_column("agent_executions", "role")
