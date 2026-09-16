# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agent_reservations table

Backs the POST /api/workspaces/{slug}/agents/{agent_id}/next-assignment
endpoint. Each row is a soft hold that one agent took on one card; it
expires automatically so a crashed runner cannot starve the board. The
unique constraint on card_id is what makes the scheduler's pick atomic
under concurrency: two simultaneous callers race to insert the same
card_id, one wins, the other retries with the next candidate.

Revision ID: 048
Revises: 047
Create Date: 2026-04-24
"""

import sqlalchemy as sa
from alembic import op

revision = "048"
down_revision = "047"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "agent_reservations",
        sa.Column("id", sa.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "agent_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("agents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "card_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "board_id",
            sa.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("role", sa.String(64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("card_id", name="uq_agent_reservations_card"),
    )
    op.create_index(
        "ix_agent_reservations_agent_id", "agent_reservations", ["agent_id"]
    )
    op.create_index(
        "ix_agent_reservations_workspace_id",
        "agent_reservations",
        ["workspace_id"],
    )
    op.create_index(
        "ix_agent_reservations_expires_at",
        "agent_reservations",
        ["expires_at"],
    )


def downgrade():
    op.drop_index("ix_agent_reservations_expires_at", table_name="agent_reservations")
    op.drop_index(
        "ix_agent_reservations_workspace_id", table_name="agent_reservations"
    )
    op.drop_index("ix_agent_reservations_agent_id", table_name="agent_reservations")
    op.drop_table("agent_reservations")
