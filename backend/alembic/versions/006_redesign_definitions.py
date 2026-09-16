# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""redesign definitions — replace deadline + metadata_json with content JSON

Revision ID: 006
Revises: 005
Create Date: 2026-03-12
"""

import sqlalchemy as sa
from alembic import op

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "definitions",
        sa.Column("content", sa.JSON(), server_default="{}", nullable=False),
    )
    # Migrate existing metadata_json into content
    op.execute("UPDATE definitions SET content = metadata_json WHERE metadata_json IS NOT NULL")
    op.drop_column("definitions", "deadline")
    op.drop_column("definitions", "metadata_json")


def downgrade() -> None:
    op.add_column(
        "definitions",
        sa.Column("metadata_json", sa.JSON(), server_default="{}", nullable=True),
    )
    op.add_column(
        "definitions",
        sa.Column("deadline", sa.DateTime(), nullable=True),
    )
    op.execute("UPDATE definitions SET metadata_json = content WHERE content IS NOT NULL")
    op.drop_column("definitions", "content")
