# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""backfill cards.description into canonical ProseMirror JSON

Editor P0-3: card descriptions get the notes normalization contract. The
schema validator now normalizes on write (schemas/kanban/card.py), but
legacy rows still hold whatever string the API received — markdown from
MCP agents being the common case. Same recipe as 056's notes backfill:

  - Stream every card row.
  - If `description` is empty → skip (empty stays "", never an empty doc).
  - If `json.loads(description)` yields a doc-shaped dict → already
    canonical, skip.
  - Otherwise → run through `normalize_note_content` and rewrite.

Idempotent: re-running this migration on already-normalized data leaves it
unchanged because step 2 short-circuits.

Rolling-update safe: purely additive data backfill, no schema change.

The migration imports from `app.services.notes.content_normalizer`. That
module must exist at upgrade time (it has shipped since 056). Running an
older alembic head against newer code is supported; running newer alembic
against older code is not (standard rolling-deploy constraint).

Revision ID: 091
Revises: 090
Create Date: 2026-08-15
"""
from __future__ import annotations

import json

import sqlalchemy as sa
from alembic import op

revision = "091"
down_revision = "090"
branch_labels = None
depends_on = None


def _is_canonical(description: str) -> bool:
    try:
        parsed = json.loads(description)
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
    cards = sa.table(
        "cards",
        sa.column("id"),
        sa.column("description"),
    )
    rows = bind.execute(sa.select(cards.c.id, cards.c.description)).fetchall()
    for row in rows:
        description = row.description or ""
        if not description or _is_canonical(description):
            continue
        normalized = normalize_note_content(description)
        bind.execute(
            sa.update(cards)
            .where(cards.c.id == row.id)
            .values(description=normalized)
        )


def downgrade():
    # Lossy by definition — once a description is canonical PM JSON, the
    # original markdown/plain-text source isn't recoverable. Leaving canonical
    # JSON in place is the safe no-op; readers handle it identically before
    # and after this migration.
    pass
