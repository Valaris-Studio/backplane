# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add agents health_loop_* columns

Loop-mode runners heartbeat on every tick including parked ones, but the body
never said which board the loop was bound to or whether the runner was ticking
or asleep. /loop/status therefore could not tell a healthy parked runner from
one that had just died -- both read `waiting`, and the chip guessed "parked"
from board readiness, which is a board property answering a runner question.

Four nullable columns, no server_default and no backfill: NULL is the domain
value "this agent has never reported loop state", which is exactly true of
every existing row and of every runner built before this change. Old runners
keep heartbeating without these fields and the service leaves them untouched;
the /loop/status ladder reads NULL as not-parked, i.e. today's behavior.

health_loop_parked_since is naive DateTime to match every other health_*
timestamp on this table (health_started_at, health_last_error_at).

Additive, rolling-deploy-safe in both directions: old code ignores the
columns, new code reads the NULLs as "no claim".

Revision ID: 086
Revises: 085
Create Date: 2026-08-12
"""

import sqlalchemy as sa
from alembic import op

revision = "086"
down_revision = "085"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agents", sa.Column("health_loop_board_id", sa.String(255), nullable=True)
    )
    op.add_column(
        "agents", sa.Column("health_loop_state", sa.String(16), nullable=True)
    )
    op.add_column(
        "agents", sa.Column("health_loop_park_reason", sa.Text(), nullable=True)
    )
    op.add_column(
        "agents", sa.Column("health_loop_parked_since", sa.DateTime(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("agents", "health_loop_parked_since")
    op.drop_column("agents", "health_loop_park_reason")
    op.drop_column("agents", "health_loop_state")
    op.drop_column("agents", "health_loop_board_id")
