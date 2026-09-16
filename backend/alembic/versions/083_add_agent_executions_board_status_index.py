# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agent_executions (board_id, status) index

Serves the loop-status truth layer's board-scoped in-flight probe
(ExecutionRepository.has_inflight_loop_iteration): the dashboard polls it per
board, and without an index the predicate walks every execution row.
board_id leads so the composite also serves plain board-scoped listings.

Additive index only — rolling-deploy-safe.

Revision ID: 083
Revises: 082
Create Date: 2026-08-08
"""

from alembic import op

revision = "083"
down_revision = "082"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_agent_executions_board_status", "agent_executions", ["board_id", "status"]
    )


def downgrade():
    op.drop_index("ix_agent_executions_board_status", "agent_executions")
