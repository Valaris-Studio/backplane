# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""card participants — junction table + drop assignee_id

Revision ID: 007
Revises: 006
Create Date: 2026-03-13
"""

import sqlalchemy as sa
from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "card_participants",
        sa.Column("card_id", sa.Uuid(), sa.ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("added_at", sa.DateTime(), server_default=sa.func.now(), nullable=False),
    )
    op.drop_column("cards", "assignee_id")


def downgrade() -> None:
    op.add_column("cards", sa.Column("assignee_id", sa.Uuid(), nullable=True))
    op.drop_table("card_participants")
