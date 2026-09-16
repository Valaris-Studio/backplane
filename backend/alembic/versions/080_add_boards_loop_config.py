# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add boards loop_config

Loop-mode config lives as a single JSON document on the board. Nullable by
contract: NULL means "never configured" and GET /loop serves 404 — no defaults
backfill. Additive, rolling-deploy-safe.

Revision ID: 080
Revises: 079
Create Date: 2026-07-31
"""

import sqlalchemy as sa
from alembic import op

revision = "080"
down_revision = "079"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("boards", sa.Column("loop_config", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("boards", "loop_config")
