# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add index on parent_execution_id for retry chain lookups

Revision ID: 025
Revises: 024
Create Date: 2026-04-12
"""
from alembic import op

revision = "025"
down_revision = "024"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_agent_executions_parent_execution_id",
        "agent_executions",
        ["parent_execution_id"],
    )


def downgrade():
    op.drop_index("ix_agent_executions_parent_execution_id", "agent_executions")
