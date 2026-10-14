# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The content level each capture record was stored at, and per session the
distinct levels ingest applied.

Purely additive and nullable, with no backfill: what was stored before this
revision has no recorded level, and NULL is how the read model says so. The
previous release keeps ingesting during a rolling deploy and leaves both
columns NULL, which reads the same way.
"""

from alembic import op
import sqlalchemy as sa

revision = "114"
down_revision = "113"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("agent_sessions") as batch:
        batch.add_column(sa.Column("capture_levels", sa.JSON(), nullable=True))
    with op.batch_alter_table("agent_session_captures") as batch:
        batch.add_column(sa.Column("content_level", sa.String(16), nullable=True))


def downgrade():
    with op.batch_alter_table("agent_session_captures") as batch:
        batch.drop_column("content_level")
    with op.batch_alter_table("agent_sessions") as batch:
        batch.drop_column("capture_levels")
