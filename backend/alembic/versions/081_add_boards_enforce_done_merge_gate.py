# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add boards enforce_done_merge_gate

Per-board override for the done-merge gate. Tri-state by design and therefore
NULLABLE with no server_default and no backfill: NULL means "inherit
workspace_config.enforce_done_merge_gate", which is exactly the behavior every
pre-migration board already has. true/false override the workspace flag for
this board alone.

Contrast with 079's is_frozen, which had to be NOT NULL: that column feeds a
`IS false` scheduler filter where a NULL row silently disappears. This one is
only ever read as a scalar by the done-gate, so three-valued logic is the
feature rather than a hazard.

Additive, rolling-deploy-safe: old code ignores the column, new code treats the
NULL every existing row carries as inherit.

Revision ID: 081
Revises: 080
Create Date: 2026-08-03
"""

import sqlalchemy as sa
from alembic import op

revision = "081"
down_revision = "080"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "boards",
        sa.Column("enforce_done_merge_gate", sa.Boolean(), nullable=True),
    )


def downgrade():
    op.drop_column("boards", "enforce_done_merge_gate")
