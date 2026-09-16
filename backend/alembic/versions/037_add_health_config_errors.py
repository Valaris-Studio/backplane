# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add health_config_errors to agents

Revision ID: 037
Revises: 036
Create Date: 2026-04-15

"""

from alembic import op
import sqlalchemy as sa

revision = "037"
down_revision = "036"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agents",
        sa.Column("health_config_errors", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("agents", "health_config_errors")
