# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add board_loop_transitions

`loop_config.disabled_reason` is a single field that a re-enable nulls and the
next disable overwrites, so a board keeps exactly ONE stop reason at a time.
Three self-improvement runs lost their true run-complete reasons that way — a
`max_iterations reached` rail stop wrote over the honest one, and
reconstructing the run meant reading git plus run-log notes.

This table is the durable timeline behind that field: append-only, one row per
enable/disable, carrying the reason, who or what flipped it, and the board's
iteration count at that moment.

ADDITIVE and rolling-deploy safe in both directions: creating a table old code
does not reference cannot affect it, and the new code writes rows only on a
loop state change. No backfill — stops that predate this migration are simply
absent from the timeline (the card puts retro-backfill out of scope), and the
UI renders an empty history as a first-class state.

`iteration_count` carries server_default="0" so a row inserted by any path
that predates the column's writer still satisfies NOT NULL.

Revision ID: 089
Revises: 088
Create Date: 2026-08-13
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "089"
down_revision = "088"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "board_loop_transitions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "board_id",
            UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "workspace_id",
            UUID(as_uuid=True),
            sa.ForeignKey("workspaces.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column(
            "actor_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "agent_id",
            UUID(as_uuid=True),
            sa.ForeignKey("agents.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "iteration_count", sa.Integer(), nullable=False, server_default="0"
        ),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_board_loop_transitions_board_id",
        "board_loop_transitions",
        ["board_id"],
    )
    op.create_index(
        "ix_board_loop_transitions_workspace_id",
        "board_loop_transitions",
        ["workspace_id"],
    )
    # The timeline query is always "this board, newest first" — the composite
    # is what keeps it an index scan instead of a sort over the board's rows.
    op.create_index(
        "ix_board_loop_transitions_board_occurred",
        "board_loop_transitions",
        ["board_id", "occurred_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_board_loop_transitions_board_occurred",
        table_name="board_loop_transitions",
    )
    op.drop_index(
        "ix_board_loop_transitions_workspace_id",
        table_name="board_loop_transitions",
    )
    op.drop_index(
        "ix_board_loop_transitions_board_id", table_name="board_loop_transitions"
    )
    op.drop_table("board_loop_transitions")
