# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add pipeline_role to card_participants

Pipeline role redesign (2026-05-16). The legacy `role` column (hero/helper/...)
becomes a display-only hint; `pipeline_role` (planner/implementer/reviewer/...)
is the canonical stage-role discriminator that role-aware discover filters
key on.

Schema-wise: nullable string, server_default NULL — safe additive change. The
backfill below derives pipeline_role from each row's most-recent execution
action where possible. Rows with no recoverable mapping stay NULL; role-aware
filters treat NULL as "no match" so legacy unmigrated cards keep their
pre-change behaviour.

Revision ID: 064
Revises: 063
Create Date: 2026-05-16
"""

import sqlalchemy as sa
from alembic import op

revision = "064"
down_revision = "063"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "card_participants",
        sa.Column("pipeline_role", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_card_participants_card_pipeline_role",
        "card_participants",
        ["card_id", "pipeline_role"],
    )
    # Bulk backfill for the only role we can derive from the row itself:
    # legacy 'hero' participants are always implementers under the new
    # taxonomy. Helper rows can't be safely classified at the SQL level
    # (no card_id on agent_executions to join through) — they stay NULL
    # and CardService.add_participant backfills them on next claim via
    # the NULL→non-NULL idempotency branch.
    op.execute(
        """
        UPDATE card_participants
        SET pipeline_role = 'implementer'
        WHERE pipeline_role IS NULL
          AND role = 'hero'
        """
    )


def downgrade():
    op.drop_index(
        "ix_card_participants_card_pipeline_role",
        table_name="card_participants",
    )
    op.drop_column("card_participants", "pipeline_role")
