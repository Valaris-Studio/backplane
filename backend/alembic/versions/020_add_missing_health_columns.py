# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add missing agent health columns

Revision ID: 020
Revises: 019
Create Date: 2026-04-12
"""
from alembic import op
import sqlalchemy as sa


revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("agents", sa.Column("health_go_version", sa.String(64), nullable=True))
    op.add_column("agents", sa.Column("health_hostname", sa.String(255), nullable=True))
    op.add_column("agents", sa.Column("health_started_at", sa.DateTime(), nullable=True))
    op.add_column("agents", sa.Column("health_cards_skipped", sa.Integer(), nullable=True))
    op.add_column("agents", sa.Column("health_current_board_id", sa.String(255), nullable=True))
    op.add_column("agents", sa.Column("health_poll_interval", sa.String(32), nullable=True))
    op.add_column("agents", sa.Column("health_card_timeout", sa.String(32), nullable=True))


def downgrade():
    op.drop_column("agents", "health_card_timeout")
    op.drop_column("agents", "health_poll_interval")
    op.drop_column("agents", "health_current_board_id")
    op.drop_column("agents", "health_cards_skipped")
    op.drop_column("agents", "health_started_at")
    op.drop_column("agents", "health_hostname")
    op.drop_column("agents", "health_go_version")
