# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add pipeline_config to workspace_configs

Revision ID: 036
Revises: 035
Create Date: 2026-04-15

"""

from alembic import op
import sqlalchemy as sa

revision = "036"
down_revision = "035"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "workspace_configs",
        sa.Column("pipeline_config", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("workspace_configs", "pipeline_config")
