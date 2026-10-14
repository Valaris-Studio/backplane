# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""An index for the session list's `sort=started` keyset, the twin of
ix_agent_sessions_owner_recent. Index only: the previous release neither
reads nor writes anything new, so a rolling deploy is safe either way.
"""

from alembic import op

revision = "116"
down_revision = "115"
branch_labels = None
depends_on = None


def upgrade():
    op.create_index(
        "ix_agent_sessions_owner_started",
        "agent_sessions",
        ["owner_id", "workspace_id", "started_at", "id"],
    )


def downgrade():
    op.drop_index("ix_agent_sessions_owner_started", table_name="agent_sessions")
