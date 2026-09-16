# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add git_repos.integration_branch

PAR-1: optional staging branch for parallel runners. NULL means "use the repo's
default_branch", which preserves pre-PAR-1 behavior. When set, stages with
git.base_ref="integration_branch" fork new branches off this ref so concurrent
runners on the same repo see each other's in-flight work.

Rolling-deploy safe: nullable, no server_default. Old code that doesn't read
the column keeps working against the new schema during the rollout window.

Revision ID: 052
Revises: 051
Create Date: 2026-04-25
"""

import sqlalchemy as sa
from alembic import op

revision = "052"
down_revision = "051"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "git_repos",
        sa.Column("integration_branch", sa.String(length=255), nullable=True),
    )


def downgrade():
    op.drop_column("git_repos", "integration_branch")
