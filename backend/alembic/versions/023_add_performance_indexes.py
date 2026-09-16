# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add performance indexes for card_participants and agent_executions

Revision ID: 023
Revises: 022
Create Date: 2026-04-12
"""
from alembic import op

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index("ix_card_participants_agent_id", "card_participants", ["agent_id"])
    op.create_index("ix_agent_executions_agent_status", "agent_executions", ["agent_id", "status"])
    op.create_index("ix_agent_executions_agent_started", "agent_executions", ["agent_id", "started_at"])


def downgrade():
    op.drop_index("ix_agent_executions_agent_started", "agent_executions")
    op.drop_index("ix_agent_executions_agent_status", "agent_executions")
    op.drop_index("ix_card_participants_agent_id", "card_participants")
