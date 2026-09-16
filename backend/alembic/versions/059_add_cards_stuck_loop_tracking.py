# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add cards.review_iterations + cards.recent_feedback_hashes

SWE-AF #2 (stuck-loop detector). Two additive, rolling-deploy-safe columns
on `cards`:

1. review_iterations (int, default 0) — monotonic counter of review_verdict
   notes seen on this card. Never resets even if a human unparks the card.
2. recent_feedback_hashes (JSON array, default []) — sliding window of the
   last 3 SHA-256 hashes of normalized verdict content. When the window
   contains >=2 collisions, the service flips `needs-advisor` onto labels.

Both nullable so old code (pre-SWE-AF #2) keeps working against the new
schema during the rollout window — NULL reads as the default in the
service layer.

Revision ID: 059
Revises: 058
Create Date: 2026-05-13
"""

import sqlalchemy as sa
from alembic import op

revision = "059"
down_revision = "058"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "cards",
        sa.Column(
            "review_iterations",
            sa.Integer(),
            nullable=True,
            server_default="0",
        ),
    )
    op.add_column(
        "cards",
        sa.Column(
            "recent_feedback_hashes",
            sa.JSON(),
            nullable=True,
            server_default="[]",
        ),
    )


def downgrade():
    op.drop_column("cards", "recent_feedback_hashes")
    op.drop_column("cards", "review_iterations")
