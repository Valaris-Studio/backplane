# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add ondelete SET NULL to activities.board_id FK

Revision ID: 009
Revises: 008
Create Date: 2026-03-16
"""

from alembic import op

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("activities_board_id_fkey", "activities", type_="foreignkey")
    op.create_foreign_key(
        "activities_board_id_fkey",
        "activities",
        "boards",
        ["board_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("activities_board_id_fkey", "activities", type_="foreignkey")
    op.create_foreign_key(
        "activities_board_id_fkey",
        "activities",
        "boards",
        ["board_id"],
        ["id"],
    )
