# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add agent_id to card_participants for agent claim observability

Revision ID: 022
Revises: 021
Create Date: 2026-04-12
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "card_participants",
        sa.Column("agent_id", UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_card_participants_agent_id",
        "card_participants",
        "agents",
        ["agent_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint("fk_card_participants_agent_id", "card_participants", type_="foreignkey")
    op.drop_column("card_participants", "agent_id")
