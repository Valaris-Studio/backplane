# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add last_key_rotated_at to agents

Operators need a timestamp for the last API-key rotation so a stale key
can be told apart from a fresh one (B14 in the 2026-04-18 runner-launch
walkthrough). The raw key is hashed on creation and unrecoverable
afterward, so without this timestamp the UI has no affordance to
communicate freshness.

Rolling-deploy safe: nullable column, no server default. Existing rows
stay NULL — those agents simply read as "never rotated (or unknown)".
Old code ignoring the column is fine; new code sets it on each call to
AgentService.rotate_api_key.

Revision ID: 046
Revises: 045
Create Date: 2026-04-18
"""

import sqlalchemy as sa
from alembic import op

revision = "046"
down_revision = "045"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agents",
        sa.Column("last_key_rotated_at", sa.DateTime(), nullable=True),
    )


def downgrade():
    op.drop_column("agents", "last_key_rotated_at")
