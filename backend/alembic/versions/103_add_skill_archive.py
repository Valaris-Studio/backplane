# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add skills.archived_at + skills.archived_by (soft-archive)

Skills soft-archive (card 60fafca6). Skills are never hard-deleted: archive
stamps `archived_at`/`archived_by`, hides the skill from the default listing,
and blocks NEW attachment points while existing bindings keep resolving.

ADDITIVE and rolling-deploy safe: both columns are nullable with no default,
so no rows are rewritten; old code never selects or writes them, new code
tolerates NULL everywhere. `archived_by` matches the model's SET NULL FK so a
deleted user never blocks or cascades into a skill row.

Revision ID: 103
Revises: 102
Create Date: 2026-08-25
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "103"
down_revision = "102"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "skills",
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "skills",
        sa.Column(
            "archived_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("skills", "archived_by")
    op.drop_column("skills", "archived_at")
