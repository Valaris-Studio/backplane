# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add cost_usd to agent_executions

Revision ID: 021
Revises: 020
Create Date: 2026-04-12
"""
from alembic import op
import sqlalchemy as sa


revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("agent_executions", sa.Column("cost_usd", sa.Float(), nullable=True))


def downgrade():
    op.drop_column("agent_executions", "cost_usd")
