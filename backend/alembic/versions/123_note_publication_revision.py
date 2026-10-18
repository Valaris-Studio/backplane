# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The canonical revision an excerpt save published, on its existing receipt.

Additive and rolling-safe: nullable columns with no default and no backfill.
The 122 release never selects them and leaves both NULL on the receipts it
writes, which readers report as a revision that was not recorded. No pairing
CHECK: readers already refuse to compare an incomplete pair, and validating one
would scan the table under an exclusive lock during the rollout."""

import sqlalchemy as sa
from alembic import op

revision = "123"
down_revision = "122"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "note_save_receipts",
        sa.Column("published_note_revision_sha256", sa.CHAR(64), nullable=True),
    )
    op.add_column(
        "note_save_receipts",
        sa.Column("published_note_revision_version", sa.SmallInteger(), nullable=True),
    )


def downgrade():
    op.drop_column("note_save_receipts", "published_note_revision_version")
    op.drop_column("note_save_receipts", "published_note_revision_sha256")
