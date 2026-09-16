# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add provider column to agent_executions

Records the RESOLVED coding-agent provider the runner actually ran for an
execution (provider-abstraction program). The runner remaps an abstract tier
to a local provider via its tier_providers config, so the backend's resolved
model/provider is only a suggestion; this column captures what truly executed
(e.g. codex-cli) so the activity feed stops showing the suggestion (opus).

Additive, nullable — rolling-deploy safe: old runners never send `provider`
(NULL), new runners do. Pairs with the existing nullable `model` column.

SQLite (test DB) adds the column as plain VARCHAR; no special handling needed.

Revision ID: 073
Revises: 072
Create Date: 2026-06-17
"""

import sqlalchemy as sa
from alembic import op

revision = "073"
down_revision = "072"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_executions",
        sa.Column("provider", sa.String(length=50), nullable=True),
    )


def downgrade():
    op.drop_column("agent_executions", "provider")
