# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add health_port to agents

Revision ID: 035
Revises: 034
Create Date: 2026-04-15

"""

from alembic import op
import sqlalchemy as sa

revision = "035"
down_revision = "034"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agents",
        sa.Column("health_port", sa.Integer(), nullable=True),
    )


def downgrade():
    op.drop_column("agents", "health_port")
