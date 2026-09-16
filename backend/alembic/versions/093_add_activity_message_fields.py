# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add structured activity message fields

Adds an optional semantic message key and JSON interpolation parameters while
preserving the existing summary column as the immutable compatibility and
fallback contract. Existing rows remain NULL and need no backfill.

Both columns are nullable with no server default so this migration is additive
and safe during a rolling deploy: old application versions ignore the columns,
while new versions continue to accept and serialize legacy rows.

Revision ID: 093
Revises: 092
Create Date: 2026-08-07
"""

import sqlalchemy as sa
from alembic import op

revision = "093"
down_revision = "092"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "activities",
        sa.Column("message_key", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "activities",
        sa.Column("message_params", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("activities", "message_params")
    op.drop_column("activities", "message_key")
