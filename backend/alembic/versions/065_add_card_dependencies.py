# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add card_dependencies join table

DEP-1 (spec note 233e4429 §Part A): first-class card-dependency primitive.

Schema:
  card_dependencies(
    card_id            UUID  FK -> cards(id)  ON DELETE CASCADE,
    depends_on_card_id UUID  FK -> cards(id)  ON DELETE CASCADE,
    created_at         TIMESTAMP server_default=now(),
    created_by         UUID  FK -> users(id),
    PRIMARY KEY (card_id, depends_on_card_id),
    CHECK (card_id <> depends_on_card_id),
    INDEX ix_card_dependencies_depends_on (depends_on_card_id)
  )

Composite PK = natural key + idempotency via INSERT ... ON CONFLICT DO NOTHING.
Mirrors CardParticipant convention. Distinct concept from `parent_card_id`
(consolidator lineage).

Pure additive — empty table on first deploy, safe under Cloud Run rolling
update.

Revision ID: 065
Revises: 064
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID
from alembic import op

revision = "065"
down_revision = "064"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "card_dependencies",
        sa.Column(
            "card_id",
            UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "depends_on_card_id",
            UUID(as_uuid=True),
            sa.ForeignKey("cards.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime,
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "card_id <> depends_on_card_id",
            name="ck_card_dependencies_no_self",
        ),
    )
    op.create_index(
        "ix_card_dependencies_depends_on",
        "card_dependencies",
        ["depends_on_card_id"],
    )


def downgrade():
    op.drop_index(
        "ix_card_dependencies_depends_on", table_name="card_dependencies"
    )
    op.drop_table("card_dependencies")
