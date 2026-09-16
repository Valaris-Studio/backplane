# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add opt-in completion policy without changing existing board behavior."""

from alembic import op
import sqlalchemy as sa

revision = "105"
down_revision = "104"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("boards", sa.Column("completion_policy", sa.JSON(), nullable=True))
    op.add_column(
        "workspace_configs", sa.Column("completion_policy", sa.JSON(), nullable=True)
    )
    op.add_column(
        "cards",
        sa.Column(
            "completion_mode", sa.String(20), nullable=False, server_default="source"
        ),
    )


def downgrade():
    op.drop_column("cards", "completion_mode")
    op.drop_column("workspace_configs", "completion_policy")
    op.drop_column("boards", "completion_policy")
