# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add cost_usd_7d and cost_usd_30d to alertmetric enum

Revision ID: 028
Revises: 027
Create Date: 2026-04-12

"""
from alembic import op

revision = "028"
down_revision = "027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # PostgreSQL enum types require ALTER TYPE to add new values.
    # These are non-transactional DDL in PG, so each runs in its own connection.
    op.execute("ALTER TYPE alertmetric ADD VALUE IF NOT EXISTS 'cost_usd_7d'")
    op.execute("ALTER TYPE alertmetric ADD VALUE IF NOT EXISTS 'cost_usd_30d'")


def downgrade() -> None:
    # PostgreSQL does not support removing values from an enum type.
    # To downgrade, you'd need to recreate the type and migrate the column.
    # This is intentionally left as a no-op since cost metrics are additive.
    pass
