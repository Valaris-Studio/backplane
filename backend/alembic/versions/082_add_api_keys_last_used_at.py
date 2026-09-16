# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add api_keys last_used_at

First-use / recency tracking for API keys, powering the MCP connection wizard's
"your agent connected" signal and a staleness view of long-lived keys.

NULLABLE with no server_default and no backfill, deliberately: NULL is the
domain value "this key has never authenticated a request". Backfilling
`now()` would mark every pre-existing key as freshly used, and a NOT NULL
sentinel (epoch) would make "never used" indistinguishable from "used in 1970"
for the IS NULL predicate the first-use transition depends on --
`UPDATE ... WHERE id = :id AND last_used_at IS NULL` is what makes that
transition atomic and single-fire under concurrent requests.

Additive, rolling-deploy-safe: old code ignores the column, new code reads the
NULL every existing row carries as never-used.

Revision ID: 082
Revises: 081
Create Date: 2026-08-04
"""

import sqlalchemy as sa
from alembic import op

revision = "082"
down_revision = "081"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "api_keys",
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    op.drop_column("api_keys", "last_used_at")
