# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add boards freeze columns

Board freeze primitive: is_frozen gates every board-scoped mutation and the
scheduler's candidate scan; frozen_at / frozen_by_id are audit fields.

Additive, rolling-deploy-safe. `is_frozen` is NOT NULL DEFAULT false — a
nullable column would three-valued-logic every pre-migration board out of the
scheduler's `is_frozen IS false` filter, which reads as a total scheduler
outage. FK is ondelete=SET NULL so deleting the freezing user never blocks.

Revision ID: 079
Revises: 078
Create Date: 2026-07-31
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "079"
down_revision = "078"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "boards",
        sa.Column(
            "is_frozen",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "boards",
        sa.Column("frozen_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "boards",
        sa.Column("frozen_by_id", postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_boards_frozen_by_id",
        "boards",
        "users",
        ["frozen_by_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade():
    op.drop_constraint("fk_boards_frozen_by_id", "boards", type_="foreignkey")
    op.drop_column("boards", "frozen_by_id")
    op.drop_column("boards", "frozen_at")
    op.drop_column("boards", "is_frozen")
