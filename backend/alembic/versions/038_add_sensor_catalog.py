# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add sensor_catalog to agents

Revision ID: 038
Revises: 037
Create Date: 2026-04-16

"""

from alembic import op
import sqlalchemy as sa

revision = "038"
down_revision = "037"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agents",
        sa.Column("sensor_catalog", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("agents", "sensor_catalog")
