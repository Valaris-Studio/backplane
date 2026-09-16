# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agent_executions.prompt_slug + agent_executions.model

Wave 2 / CRIT-2 (per-role provider/model): the runner stamps the prompt_slug
it rendered AND the LLM model it actually executed on each execution row.
Frontend timeline / per-execution detail UIs currently render em-dashes for
both — these columns are the durable backing store.

Both nullable, no server default. Old runners (pre-rollout) don't send them
and rows stay NULL; the frontend keeps the em-dash placeholder. Additive,
rolling-deploy-safe.

Revision ID: 062
Revises: 061
Create Date: 2026-05-15
"""

import sqlalchemy as sa
from alembic import op

revision = "062"
down_revision = "061"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_executions",
        sa.Column("prompt_slug", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "agent_executions",
        sa.Column("model", sa.String(length=100), nullable=True),
    )


def downgrade():
    op.drop_column("agent_executions", "model")
    op.drop_column("agent_executions", "prompt_slug")
