# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agent last_seen_at

Revision ID: 017
Revises: 016
Create Date: 2026-04-11

"""
from alembic import op
import sqlalchemy as sa

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("last_seen_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "last_seen_at")
