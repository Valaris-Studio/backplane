# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add git_repo_slug to cards

Multi-repo boards: a board may host more than one git_repo (e.g. a backend and
a frontend repo for one product). A card selects WHICH repo it targets via
`git_repo_slug`, matched against `git_repos.slug`. The scheduler resolves it in
_build_bundle; NULL means "the board's primary/first repo" and an unknown slug
degrades to that same primary.

Schema-wise: nullable string, no server_default — safe additive change under
rolling deploys. NULL (every existing card) preserves the prior single-repo
resolution bit-for-bit; old code that never reads the column is unaffected. See
project_consolidation_and_fe_revamp_2026_06_04.

Revision ID: 068
Revises: 067
Create Date: 2026-06-04
"""

import sqlalchemy as sa
from alembic import op

revision = "068"
down_revision = "067"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "cards",
        sa.Column("git_repo_slug", sa.String(length=255), nullable=True),
    )


def downgrade():
    op.drop_column("cards", "git_repo_slug")
