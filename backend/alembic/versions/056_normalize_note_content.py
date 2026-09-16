# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""backfill notes.content into canonical ProseMirror JSON

The TipTap renderer expects PM JSON. Pre-normalizer notes (especially those
created via MCP `create_note`/`update_note` by AI agents) often hold raw
markdown — these render as a flat blob. The schema validator now normalizes
on write, but legacy rows still need a one-time backfill.

Strategy:
  - Stream every note row.
  - If `content` is empty → skip.
  - If `json.loads(content)` yields a doc-shaped dict → already canonical, skip.
  - Otherwise → run through `normalize_note_content` and rewrite.

Idempotent: re-running this migration on already-normalized data leaves it
unchanged because step 2 short-circuits.

The migration imports from `app.services.notes.content_normalizer`. That
module must exist at upgrade time (it ships in the same release as this
migration). Running an older alembic head against newer code is supported;
running newer alembic against older code is not (standard rolling-deploy
constraint).

Revision ID: 056
Revises: 055
Create Date: 2026-05-04
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "056"
down_revision = "055"
branch_labels = None
depends_on = None


def _is_canonical(content: str) -> bool:
    try:
        parsed = json.loads(content)
    except (json.JSONDecodeError, TypeError):
        return False
    return isinstance(parsed, dict) and parsed.get("type") == "doc"


def upgrade():
    # Imported lazily so `alembic heads` (and other static commands that
    # only need the revision graph) don't require the app's import path.
    from app.services.notes.content_normalizer import normalize_note_content

    bind = op.get_bind()
    # Untyped columns — let the connection's dialect handle bind types.
    # In prod that's PG UUID; the in-test SQLite uses String. Both work.
    notes = sa.table(
        "notes",
        sa.column("id"),
        sa.column("content"),
    )
    rows = bind.execute(sa.select(notes.c.id, notes.c.content)).fetchall()
    for row in rows:
        content = row.content or ""
        if not content or _is_canonical(content):
            continue
        normalized = normalize_note_content(content)
        bind.execute(
            sa.update(notes)
            .where(notes.c.id == row.id)
            .values(content=normalized)
        )


def downgrade():
    # Lossy by definition — once content is canonical PM JSON, the original
    # markdown/HTML/plain-text source isn't recoverable. Leaving canonical
    # JSON in place is the safe no-op; the renderer handles it identically
    # before and after this migration.
    pass
