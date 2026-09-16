# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add via_api_key column to activities

Revision ID: 011
Revises: 010
Create Date: 2026-03-26
"""

import sqlalchemy as sa
from alembic import op

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("activities", sa.Column("via_api_key", sa.String(255), nullable=True))


def downgrade() -> None:
    op.drop_column("activities", "via_api_key")
