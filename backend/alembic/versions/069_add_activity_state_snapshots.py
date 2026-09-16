# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add before_state/after_state snapshots to activities

Board Timeline Simulator (frozen contract v1). Two nullable JSON columns hold
the role-agnostic entity snapshot before and after each event so the FE can fold
events forward to reconstruct any board frame. Old rows stay NULL — the FE
treats null-snapshot events best-effort. Additive + nullable = rolling-deploy
safe; old code that never reads/writes them is unaffected.

Revision ID: 069
Revises: 068
Create Date: 2026-06-08
"""

import sqlalchemy as sa
from alembic import op

revision = "069"
down_revision = "068"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("activities", sa.Column("before_state", sa.JSON(), nullable=True))
    op.add_column("activities", sa.Column("after_state", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("activities", "after_state")
    op.drop_column("activities", "before_state")
