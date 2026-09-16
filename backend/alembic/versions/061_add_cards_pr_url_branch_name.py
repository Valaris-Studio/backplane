# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add cards.pr_url + cards.branch_name

UX-3: promote PR URL and branch name from description-footer parsing
("---\nBranch: <b>\nPR: <url>") to first-class card columns. Two additive,
rolling-deploy-safe columns:

1. pr_url (String(500), nullable) — URL of the most recent PR opened for
   the card. The runner writes both this column and the legacy footer for
   one deploy cycle; frontend prefers the column and falls back to footer
   parsing for historical rows where the column is NULL.
2. branch_name (String(255), nullable) — branch the runner pushed.

Both nullable, no server default — old code paths keep working untouched
during the rollout window because NULL means "fall back to footer".

Revision ID: 061
Revises: 060
Create Date: 2026-05-15
"""

import sqlalchemy as sa
from alembic import op

revision = "061"
down_revision = "060"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("cards", sa.Column("pr_url", sa.String(length=500), nullable=True))
    op.add_column("cards", sa.Column("branch_name", sa.String(length=255), nullable=True))


def downgrade():
    op.drop_column("cards", "branch_name")
    op.drop_column("cards", "pr_url")
