# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add require_branch_protection to git_repos

T2.3b. Backend marks intent — runner applies provider-neutral
EnsureBranchProtection at first clone. Defaults to True so
agent-driven auto-merge always has protection to arm against.
Operators can disable per-repo for legacy/human-owned repos.

Rolling-deploy safe: server_default=true + nullable=False means
old code running against the new schema gets the default value on
insert without crashing; new code reads the flag.

Revision ID: 044
Revises: 043
Create Date: 2026-04-17
"""

import sqlalchemy as sa
from alembic import op

revision = "044"
down_revision = "043"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "git_repos",
        sa.Column(
            "require_branch_protection",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )


def downgrade():
    op.drop_column("git_repos", "require_branch_protection")
