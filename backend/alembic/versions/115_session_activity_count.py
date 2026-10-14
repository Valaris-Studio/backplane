# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""How many of a session's stored events are activity, so a session whose
agent reported only token usage can say so.

Additive, nullable and without a server default or a backfill here. The
previous release keeps ingesting during a rolling deploy without maintaining
the count, so any value written now could go stale; NULL instead means "not
counted", which reads count from events and the next ingest fills exactly.
`python -m scripts.recount_session_activity --apply` fills the rest once the
rollout has finished (`--all` also recounts sessions old code touched after
new code had counted them).
"""

from alembic import op
import sqlalchemy as sa

revision = "115"
down_revision = "114"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("agent_sessions") as batch:
        batch.add_column(sa.Column("activity_event_count", sa.Integer(), nullable=True))


def downgrade():
    with op.batch_alter_table("agent_sessions") as batch:
        batch.drop_column("activity_event_count")
