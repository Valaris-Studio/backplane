# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add ship_warnings to agent_executions

Runners accumulate non-fatal issues during a stage (e.g. auto-merge arming
failed because branch protection rules are not configured on the default
branch — B16 in the 2026-04-18 runner-launch walkthrough). Before this
column, those warnings stayed in the Go runner's local slog and never
reached platform telemetry, so the frontend execution detail showed no
signal that the runner had tried and failed to arm auto-merge.

Rolling-deploy safe: nullable JSON column, no server default. Existing
rows stay NULL — older runners simply don't report warnings, and the UI
treats NULL the same as an empty list (no chip rendered). New writers
pass the collected warnings in the execution-update payload.

Revision ID: 047
Revises: 046
Create Date: 2026-04-18
"""

import sqlalchemy as sa
from alembic import op

revision = "047"
down_revision = "046"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_executions",
        sa.Column("ship_warnings", sa.JSON(), nullable=True),
    )


def downgrade():
    op.drop_column("agent_executions", "ship_warnings")
