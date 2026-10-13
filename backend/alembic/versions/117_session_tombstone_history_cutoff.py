# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A tombstone's history cutoff: what a deleted session observed at or before
it stays deleted, later activity is captured again. Nullable and not
backfilled: ingest reads a missing cutoff, or one computed for another
deletion than the stored deleted_at, as deleted_at plus the clock-skew bound,
which also covers tombstones the previous release writes mid-deploy.

The receipts index serves the device clock-lead measurement at deletion; the
tombstones index serves ingest's lookup of a native session's tombstones in
every workspace.
"""

import sqlalchemy as sa
from alembic import op

revision = "117"
down_revision = "116"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "agent_session_tombstones",
        sa.Column("history_cutoff", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "agent_session_tombstones",
        sa.Column(
            "history_cutoff_deleted_at", sa.DateTime(timezone=True), nullable=True
        ),
    )
    op.create_index(
        "ix_agent_session_captures_installation_received",
        "agent_session_captures",
        ["installation_id", "received_at"],
    )
    op.create_index(
        "ix_agent_session_tombstones_installation_native",
        "agent_session_tombstones",
        ["installation_id", "native_session_id"],
    )


def downgrade():
    op.drop_index(
        "ix_agent_session_tombstones_installation_native",
        table_name="agent_session_tombstones",
    )
    op.drop_index(
        "ix_agent_session_captures_installation_received",
        table_name="agent_session_captures",
    )
    with op.batch_alter_table("agent_session_tombstones") as batch:
        batch.drop_column("history_cutoff_deleted_at")
        batch.drop_column("history_cutoff")
