# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add agent_id column to activities table

Revision ID: 014
Revises: 013
Create Date: 2026-04-10
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "activities",
        sa.Column("agent_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_activities_agent_id",
        "activities",
        "agents",
        ["agent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_activities_agent", "activities", ["agent_id"])


def downgrade() -> None:
    op.drop_index("ix_activities_agent", table_name="activities")
    op.drop_constraint("fk_activities_agent_id", "activities", type_="foreignkey")
    op.drop_column("activities", "agent_id")
