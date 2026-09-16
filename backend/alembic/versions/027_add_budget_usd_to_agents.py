# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add budget_usd to agents

Revision ID: 027
Revises: 026
Create Date: 2026-04-12
"""
from alembic import op
import sqlalchemy as sa

revision = "027"
down_revision = "026"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agents",
        sa.Column("budget_usd", sa.Float(), nullable=True),
    )


def downgrade():
    op.drop_column("agents", "budget_usd")
