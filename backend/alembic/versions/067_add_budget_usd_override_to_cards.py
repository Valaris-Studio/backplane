# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add budget_usd_override to cards

Cluster I (outcome taxonomy + event→reschedule). A card may carry an optional
per-card budget runway (USD) the runner consults to give an outsized card more
runway than the workspace-global `max_budget_usd` yaml ceiling — without
editing the global config.

Schema-wise: nullable float, no server_default — safe additive change under
rolling deploys. NULL means "no override, use the global ceiling"; old code
that never reads the column is unaffected.

Revision ID: 067
Revises: 066
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op

revision = "067"
down_revision = "066"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "cards",
        sa.Column("budget_usd_override", sa.Float(), nullable=True),
    )


def downgrade():
    op.drop_column("cards", "budget_usd_override")
