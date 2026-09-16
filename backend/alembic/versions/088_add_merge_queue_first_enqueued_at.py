# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add merge_queue_entries first_enqueued_at

`enqueued_at` has two jobs and they conflict. It is the FIFO sort key, so
re_enqueue bumps it to now() on every retry to stop a churning entry from
starving fresh ones behind it -- and it was also what board health measured
staleness from. The result (proxmox Round 11): an entry churning ci_not_green
every 10s for 20 minutes never crossed MERGE_QUEUE_STALE_THRESHOLD_SECONDS,
because its age reset with each attempt. The single most operator-relevant
stuck state was the one the detector could not see.

This column splits the two jobs: enqueued_at stays the FIFO position,
first_enqueued_at is when the entry entered the queue and is never bumped.

Nullable with no server_default and no backfill: NULL is the domain value
"written before this migration". Readers fall back to enqueued_at, which is
exactly today's behavior, and the first retry after the deploy adopts the row's
current enqueued_at as its origin rather than restarting the clock. Old code
ignores the column entirely, so the rolling update is safe both directions.

Naive DateTime to match every other timestamp on merge_queue_entries
(enqueued_at, merged_at, stale_notified_at).

Revision ID: 088
Revises: 087
Create Date: 2026-08-13
"""

import sqlalchemy as sa
from alembic import op

revision = "088"
down_revision = "087"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "merge_queue_entries",
        sa.Column("first_enqueued_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("merge_queue_entries", "first_enqueued_at")
