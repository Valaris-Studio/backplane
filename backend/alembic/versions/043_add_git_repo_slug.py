# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add slug column to git_repos with per-board uniqueness

T2.3a. Introduces a human-readable identifier so API clients (runner,
MCP) can reference repos by slug instead of UUID. Board-scoped uniqueness
mirrors GitRepo's ownership model — a board owns a handful of repos.

Strategy (Cloud Run rolling-deploy safe):
1. Add nullable `slug` column.
2. Backfill from `name` with per-board dedup (Python-side loop).
3. Create unique index on (board_id, slug) and plain index on slug.

Revision ID: 043
Revises: 042
Create Date: 2026-04-17
"""

import re

import sqlalchemy as sa
from alembic import op

revision = "043"
down_revision = "042"
branch_labels = None
depends_on = None

_SLUG_RE = re.compile(r"[^a-z0-9]+")


def _slugify(value: str) -> str:
    slug = _SLUG_RE.sub("-", (value or "").lower()).strip("-")
    return slug or "repo"


def upgrade():
    op.add_column(
        "git_repos",
        sa.Column("slug", sa.String(length=255), nullable=True),
    )

    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, board_id, name FROM git_repos ORDER BY created_at")
    ).fetchall()

    # Per-board set of taken slugs. Disambiguate by appending -2, -3, ...
    taken: dict[str, set[str]] = {}
    for row in rows:
        repo_id, board_id, name = row
        board_key = str(board_id)
        base = _slugify(name)
        used = taken.setdefault(board_key, set())
        candidate = base
        suffix = 2
        while candidate in used:
            candidate = f"{base}-{suffix}"
            suffix += 1
        used.add(candidate)
        bind.execute(
            sa.text("UPDATE git_repos SET slug = :slug WHERE id = :id"),
            {"slug": candidate, "id": repo_id},
        )

    op.create_index("ix_git_repos_slug", "git_repos", ["slug"])
    op.create_unique_constraint(
        "uq_git_repos_board_slug", "git_repos", ["board_id", "slug"]
    )


def downgrade():
    op.drop_constraint("uq_git_repos_board_slug", "git_repos", type_="unique")
    op.drop_index("ix_git_repos_slug", table_name="git_repos")
    op.drop_column("git_repos", "slug")
