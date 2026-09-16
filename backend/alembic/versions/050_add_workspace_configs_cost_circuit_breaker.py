# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add workspace_configs.cost_circuit_breaker

Per-workspace cost circuit breaker config (card e244867f). NULL = disabled.
When populated, expected shape:
    {
      "enabled": bool,
      "threshold_usd_per_15min": float,
      "action": "alert" | "pause" | "kill_runner"
    }

Rolling-deploy safe: nullable, no server_default. Old code that doesn't read
the column keeps working against the new schema during the rollout window.

Revision ID: 050
Revises: 049
Create Date: 2026-04-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSON

revision = "050"
down_revision = "049"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "workspace_configs",
        sa.Column("cost_circuit_breaker", JSON, nullable=True),
    )


def downgrade():
    op.drop_column("workspace_configs", "cost_circuit_breaker")
