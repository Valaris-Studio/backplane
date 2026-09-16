# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""widen cards.status to 255

An agent's natural closure status is a sha, a PR number and a clause — often in
Spanish — which routinely runs past 100 characters. Four self-improvement runs
produced the same workaround: every loop prompt carries a "keep status under
100 chars" rule, and a field run (2026-08-09) degraded to recording closure in
description prose, which defeats the point of a structured field. 100 was an
arbitrary width, never a domain rule.

ADDITIVE and rolling-deploy safe in both directions. In Postgres, widening a
varchar is a metadata-only ALTER: it rewrites no rows and takes no lock a
rolling update can trip over. Old code briefly running against the new schema
keeps writing values <= 100, which stay valid; new code writing up to 255 is
rejected at the Pydantic layer (STATUS_MAX_LENGTH), so nothing over-length
reaches a replica still on the old column.

The downgrade is deliberately NOT a narrowing back to 100: shrinking a varchar
that already holds longer values fails outright, and truncating operator data
to make a rollback succeed is worse than leaving the column wide. A wide column
is harmless to old code, so the downgrade is a documented no-op.

Revision ID: 090
Revises: 089
Create Date: 2026-08-13
"""

import sqlalchemy as sa
from alembic import op

revision = "090"
down_revision = "089"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "cards",
        "status",
        existing_type=sa.String(100),
        type_=sa.String(255),
        existing_nullable=True,
    )


def downgrade() -> None:
    """No-op: see the module docstring — narrowing would fail on live data."""
