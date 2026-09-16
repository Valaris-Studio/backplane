# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add slug to agent_teams with workspace-unique constraint

Adds nullable `slug` column, backfills from name with per-workspace
disambiguation, creates a workspace-unique constraint, and indexes
the slug column for slug-based lookup.

Revision ID: 042
Revises: 041
Create Date: 2026-04-17

Depends on sibling slug migrations 040 (board) and 041 (git_repo).
If integration order differs, update down_revision accordingly.
"""

import re

import sqlalchemy as sa
from alembic import op

revision = "042"
down_revision = "041"
branch_labels = None
depends_on = None


_SLUG_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _slugify(value: str, fallback: str = "team") -> str:
    slug = _SLUG_NON_ALNUM.sub("-", (value or "").lower()).strip("-")
    return slug or fallback


def upgrade():
    op.add_column(
        "agent_teams",
        sa.Column("slug", sa.String(length=255), nullable=True),
    )

    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT id, workspace_id, name FROM agent_teams ORDER BY created_at")
    ).fetchall()

    used_per_workspace: dict[str, set[str]] = {}
    for row in rows:
        team_id, workspace_id, name = row[0], row[1], row[2]
        ws_key = str(workspace_id)
        taken = used_per_workspace.setdefault(ws_key, set())

        base = _slugify(name)
        candidate = base
        suffix = 2
        while candidate in taken:
            candidate = f"{base}-{suffix}"
            suffix += 1
        taken.add(candidate)

        bind.execute(
            sa.text("UPDATE agent_teams SET slug = :slug WHERE id = :id"),
            {"slug": candidate, "id": team_id},
        )

    op.create_index("ix_agent_teams_slug", "agent_teams", ["slug"])
    op.create_unique_constraint(
        "uq_agent_teams_workspace_slug",
        "agent_teams",
        ["workspace_id", "slug"],
    )


def downgrade():
    op.drop_constraint(
        "uq_agent_teams_workspace_slug", "agent_teams", type_="unique"
    )
    op.drop_index("ix_agent_teams_slug", table_name="agent_teams")
    op.drop_column("agent_teams", "slug")
