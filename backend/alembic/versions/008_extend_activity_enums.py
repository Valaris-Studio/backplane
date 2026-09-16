# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""extend activity enums — add workspace/member entity types, added_member/removed_member actions, actor index

Revision ID: 008
Revises: 007
Create Date: 2026-03-15
"""

from alembic import op

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction in PostgreSQL
    op.execute("ALTER TYPE activityentitytype ADD VALUE IF NOT EXISTS 'workspace'")
    op.execute("ALTER TYPE activityentitytype ADD VALUE IF NOT EXISTS 'member'")
    op.execute("ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'added_member'")
    op.execute("ALTER TYPE activityaction ADD VALUE IF NOT EXISTS 'removed_member'")
    op.create_index("ix_activities_actor", "activities", ["actor_id"])


def downgrade() -> None:
    op.drop_index("ix_activities_actor", table_name="activities")
    # PostgreSQL doesn't support removing enum values — manual cleanup needed
