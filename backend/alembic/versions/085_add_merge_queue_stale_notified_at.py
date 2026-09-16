# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add merge_queue_entries stale_notified_at

The once-per-crossing latch for the `merge_queue.stale` WS event. Board health
is computed per-HTTP-request by a fresh service instance, across several Cloud
Run instances, so "have we already told the operator about this entry?" cannot
live in process memory -- it has to be durable and shared.

NULLABLE with no server_default and no backfill, deliberately: NULL is the
domain value "this entry has never been reported stale". Backfilling now()
would silence the notification for every entry currently wedged -- exactly the
population the event exists to surface -- and a NOT NULL sentinel would break
the `UPDATE ... WHERE id = :id AND stale_notified_at IS NULL` predicate that
makes the transition atomic and single-fire under concurrent health polls.

Naive DateTime to match every other timestamp on merge_queue_entries
(enqueued_at, merged_at); the table predates the timezone-aware convention and
BoardHealthService strips tzinfo when it compares ages.

Additive, rolling-deploy-safe: old code ignores the column, new code reads the
NULL every existing row carries as never-notified.

Revision ID: 085
Revises: 084
Create Date: 2026-08-11
"""

import sqlalchemy as sa
from alembic import op

revision = "085"
down_revision = "084"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "merge_queue_entries",
        sa.Column("stale_notified_at", sa.DateTime(), nullable=True),
    )


def downgrade():
    op.drop_column("merge_queue_entries", "stale_notified_at")
