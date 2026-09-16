# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add metadata and description columns to resources

Revision ID: 003
Revises: 002
Create Date: 2026-03-11
"""

import sqlalchemy as sa

from alembic import op

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "resources",
        sa.Column("metadata", sa.JSON(), server_default="{}", nullable=False),
    )
    op.add_column(
        "resources",
        sa.Column("description", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("resources", "description")
    op.drop_column("resources", "metadata")
