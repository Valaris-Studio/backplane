# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Add optional source fingerprints for active completion context."""

from alembic import op
import sqlalchemy as sa

revision = "107"
down_revision = "106"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("completion_attempts", sa.Column("context_manifest", sa.JSON(), nullable=True))


def downgrade():
    op.drop_column("completion_attempts", "context_manifest")
