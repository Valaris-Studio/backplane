# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add due_date, status, labels columns to cards

Revision ID: 005
Revises: 004
Create Date: 2026-03-12
"""

import sqlalchemy as sa

from alembic import op

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "cards",
        sa.Column("due_date", sa.Date(), nullable=True),
    )
    op.add_column(
        "cards",
        sa.Column("status", sa.String(100), nullable=True),
    )
    op.add_column(
        "cards",
        sa.Column("labels", sa.JSON(), server_default="[]", nullable=True),
    )


def downgrade() -> None:
    op.drop_column("cards", "labels")
    op.drop_column("cards", "status")
    op.drop_column("cards", "due_date")
