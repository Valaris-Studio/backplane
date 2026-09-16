# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""extend activityaction enum with dependency_added/removed/replaced

DEP-4 (spec note 233e4429 §A7). Adds three new values to the Postgres
`activityaction` enum so DependencyService can record card-dependency
activity rows.

Mirrors the ALTER TYPE ADD VALUE IF NOT EXISTS pattern from
008_extend_activity_enums.py — non-transactional in Postgres but
idempotent on re-run.

Revision ID: 066
Revises: 065
Create Date: 2026-05-20
"""

from alembic import op

revision = "066"
down_revision = "065"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'dependency_added'"
    )
    op.execute(
        "ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'dependency_removed'"
    )
    op.execute(
        "ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'dependencies_replaced'"
    )


def downgrade() -> None:
    # PostgreSQL doesn't support removing enum values cleanly — manual cleanup.
    pass
