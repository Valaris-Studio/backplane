# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add health reporting columns to agents table

Revision ID: 018
Revises: 017
Create Date: 2026-04-11

"""
import sqlalchemy as sa
from alembic import op

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agents", sa.Column("health_status", sa.String(32), nullable=True))
    op.add_column("agents", sa.Column("health_version", sa.String(64), nullable=True))
    op.add_column("agents", sa.Column("health_uptime_seconds", sa.Integer(), nullable=True))
    op.add_column("agents", sa.Column("health_cards_processed", sa.Integer(), nullable=True))
    op.add_column("agents", sa.Column("health_cards_failed", sa.Integer(), nullable=True))
    op.add_column("agents", sa.Column("health_current_card_id", sa.String(255), nullable=True))
    op.add_column("agents", sa.Column("health_last_error", sa.Text(), nullable=True))
    op.add_column("agents", sa.Column("health_last_error_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("agents", "health_last_error_at")
    op.drop_column("agents", "health_last_error")
    op.drop_column("agents", "health_current_card_id")
    op.drop_column("agents", "health_cards_failed")
    op.drop_column("agents", "health_cards_processed")
    op.drop_column("agents", "health_uptime_seconds")
    op.drop_column("agents", "health_version")
    op.drop_column("agents", "health_status")
