# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""give config_templates.name a draft half

Card 615c3b6e (p1-backend). `name` was the only editable template field without
a `draft_*` column, so the autosave PATCH wrote the SHARED column: a rename took
effect the instant it was typed, on every published-half consumer, while the
boards involved were still running the old published template. Its two siblings
(`profile`, `content`) split correctly, which is why the gap survived review.

ADDITIVE, and safe under Cloud Run rolling updates. This adds one NULLABLE
column and rewrites no existing row: `ALTER TABLE ... ADD COLUMN` without a
default is a metadata-only catalog change in Postgres 11+, taking no table
rewrite and no long lock. During a rolling update both code versions run
against the widened table — OLD code never selects or writes `draft_name` and
is unaffected by its presence, while NEW code treats NULL as "no pending
rename" and falls back to the published `name`. That fallback is what makes a
backfill unnecessary: every pre-existing row reads exactly as it did before.

NULL is therefore load-bearing, not laziness. It is the honest encoding of "this
row has never been renamed since its last publish", and it is distinct from an
empty string, which would be a rename TO blank.

No dialect guard: the SQLite test suite builds its schema from
`Base.metadata.create_all`, never from alembic.

Revision ID: 098
Revises: 097
Create Date: 2026-08-17
"""

import sqlalchemy as sa
from alembic import op

revision = "098"
down_revision = "097"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "config_templates",
        sa.Column("draft_name", sa.String(255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("config_templates", "draft_name")
