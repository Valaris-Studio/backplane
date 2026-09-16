# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add tags column to boards

Revision ID: 004
Revises: 003
Create Date: 2026-03-12
"""

import sqlalchemy as sa

from alembic import op

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "boards",
        sa.Column("tags", sa.JSON(), server_default="[]", nullable=True),
    )


def downgrade() -> None:
    op.drop_column("boards", "tags")
