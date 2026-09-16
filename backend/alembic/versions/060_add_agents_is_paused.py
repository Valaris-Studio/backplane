# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agents.is_paused

Card 49f8bb82 (runner pause primitive). Additive, rolling-deploy-safe
column on `agents`. NULL is read as False in the service layer, so old
code running against the new schema during the rollover behaves as if
every existing runner is unpaused.

Revision ID: 060
Revises: 059
Create Date: 2026-05-13
"""

import sqlalchemy as sa
from alembic import op

revision = "060"
down_revision = "059"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agents",
        sa.Column(
            "is_paused",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )


def downgrade():
    op.drop_column("agents", "is_paused")
