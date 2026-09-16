# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add card_id to notes

Revision ID: 030
Revises: 029
Create Date: 2026-04-14

"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "030"
down_revision = "029"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("notes", sa.Column("card_id", postgresql.UUID(as_uuid=True), nullable=True))
    op.create_index("ix_notes_card_id", "notes", ["card_id"])
    op.create_foreign_key("fk_notes_card_id", "notes", "cards", ["card_id"], ["id"], ondelete="SET NULL")


def downgrade() -> None:
    op.drop_constraint("fk_notes_card_id", "notes", type_="foreignkey")
    op.drop_index("ix_notes_card_id", "notes")
    op.drop_column("notes", "card_id")
