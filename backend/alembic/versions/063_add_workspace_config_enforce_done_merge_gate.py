# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add workspace_configs.enforce_done_merge_gate

Card dad09e90: workspaces can now opt out of the Done-merge gate that requires
agent-driven Done moves to have a merged PR. Defaults to True (existing behavior).

Additive, server_default true so old code reading the new schema during a
rolling deploy sees the historical behavior.

Revision ID: 063
Revises: 062
Create Date: 2026-05-15
"""

import sqlalchemy as sa
from alembic import op

revision = "063"
down_revision = "062"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "workspace_configs",
        sa.Column(
            "enforce_done_merge_gate",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )


def downgrade():
    op.drop_column("workspace_configs", "enforce_done_merge_gate")
