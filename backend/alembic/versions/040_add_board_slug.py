# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add slug to boards with workspace-unique constraint

Nullable column first for rolling-deploy safety, then Python-side backfill
from `name` (disambiguating duplicates per workspace), then index + unique
constraint. A follow-up migration will tighten to NOT NULL once all writers
have rolled over.

Revision ID: 040
Revises: 039
Create Date: 2026-04-17
"""

import re

from alembic import op
import sqlalchemy as sa


revision = "040"
down_revision = "039"
branch_labels = None
depends_on = None


_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _slugify(value: str, fallback: str = "board") -> str:
    slug = _NON_ALNUM.sub("-", (value or "").lower()).strip("-")
    return slug or fallback


def upgrade():
    op.add_column("boards", sa.Column("slug", sa.String(length=255), nullable=True))

    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, workspace_id, name FROM boards ORDER BY created_at")
    ).fetchall()

    # Track slugs taken per workspace so duplicate names produce foo, foo-2, ...
    taken: dict[str, set[str]] = {}
    for row in rows:
        board_id, workspace_id, name = row[0], row[1], row[2]
        ws_key = str(workspace_id)
        used = taken.setdefault(ws_key, set())

        base = _slugify(name)
        candidate = base
        counter = 2
        while candidate in used:
            candidate = f"{base}-{counter}"
            counter += 1
        used.add(candidate)

        bind.execute(
            sa.text("UPDATE boards SET slug = :slug WHERE id = :id"),
            {"slug": candidate, "id": board_id},
        )

    op.create_index("ix_boards_slug", "boards", ["slug"])
    op.create_unique_constraint(
        "uq_boards_workspace_slug", "boards", ["workspace_id", "slug"]
    )


def downgrade():
    op.drop_constraint("uq_boards_workspace_slug", "boards", type_="unique")
    op.drop_index("ix_boards_slug", table_name="boards")
    op.drop_column("boards", "slug")
