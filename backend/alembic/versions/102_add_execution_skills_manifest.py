# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agent_executions.skills manifest column

Skills Registry W3 (card cdcf94b7). The runner reports which skills
(slug/name/description/version/content_hash) it actually materialized for a
stage; the row records that manifest. NULL = never reported (old runner / no
skills), the ship_warnings precedent. Plain JSON — never queried by
containment, so no JSONB variant or GIN index.

ADDITIVE and safe under Cloud Run rolling updates: a nullable column with no
default rewrites no rows; old code never selects or writes it, new code
tolerates NULL everywhere.

Revision ID: 102
Revises: 101
Create Date: 2026-08-24
"""

import sqlalchemy as sa
from alembic import op

revision = "102"
down_revision = "101"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_executions",
        sa.Column("skills", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("agent_executions", "skills")
