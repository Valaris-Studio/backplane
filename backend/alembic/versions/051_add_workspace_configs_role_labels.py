# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add workspace_configs.role_labels

Per-workspace role display registry (card 86ca1421 Phase A). NULL means
"use platform defaults". When populated, expected shape:
    {"<role>": {"display_name": str, "color": "#hex"}}

Per feedback_extensibility_no_limits.md, this column is intentionally NOT
an allow-list — workspaces can register any role string. Phase B/C
consumers (frontend ROLE_COLORS, Go capitalizeRole) read this dictionary
instead of hardcoding their own.

Rolling-deploy safe: nullable, no server_default. Old code that doesn't
read the column keeps working against the new schema during the rollout
window.

Revision ID: 051
Revises: 050
Create Date: 2026-04-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON

revision = "051"
down_revision = "050"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "workspace_configs",
        sa.Column("role_labels", JSON, nullable=True),
    )


def downgrade():
    op.drop_column("workspace_configs", "role_labels")
