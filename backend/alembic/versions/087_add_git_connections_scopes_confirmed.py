# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add git_connections.scopes_confirmed

Verify has always computed per-duty checks and thrown them away, so the
connections list could only ever read identity health: an under-scoped GitHub
fine-grained PAT rendered the same green "Working" chip as a token that can
actually push branches and merge PRs. This column is that discarded scope
verdict, kept.

Nullable with no server_default and no backfill: NULL is the domain value
"no probe has ever assessed this row", which is exactly true of every row
written before this change. Old code ignores the column; new code reads NULL
as unassessed and leaves the chip on today's identity-only verdict, so the
deploy is safe in both directions under a rolling update.

Revision ID: 087
Revises: 086
Create Date: 2026-08-12
"""

import sqlalchemy as sa
from alembic import op

revision = "087"
down_revision = "086"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "git_connections",
        sa.Column("scopes_confirmed", sa.Boolean(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("git_connections", "scopes_confirmed")
