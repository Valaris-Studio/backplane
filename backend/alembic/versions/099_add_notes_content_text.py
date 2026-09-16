# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""add notes.content_text + backfill it from content

Server-side note search needs a column it can ILIKE. `content` is ProseMirror
JSON, so `content ILIKE '%plan%'` matches structural tokens on every row and a
search for "heading" returns the whole workspace. `content_text` holds the same
document's plain text — what the reader actually sees — and doubles as the
source of the list preview so no row has to be parsed at serialization time.

ADDITIVE and safe under Cloud Run rolling updates. The column is NULLABLE with
no server default: `ALTER TABLE ... ADD COLUMN` is a metadata-only catalog
change in Postgres 11+, no table rewrite, no long lock. During the rollout OLD
code never selects or writes it, and NEW code treats NULL as "not extracted
yet" and falls back to parsing `content` on the fly (build_preview) — so a row
written by an old replica mid-deploy previews correctly and is still findable
by title. The backfill closes the body-search gap for every pre-existing row.

The extraction below is a DELIBERATE SELF-CONTAINED COPY of
`app.services.notes.content_text.extract_plain_text` rather than an import.
A migration is a historical record: it must produce the same output in five
years when the service-layer walker has grown mention/embed/whatever handling.
Migration 056 took the import route and thereby pinned itself to a module it
does not own; this one does not repeat that. The two are kept consistent by
`tests/services/notes/test_migration_099_extraction_parity.py`, which asserts
they agree over the shared PM corpus.

Idempotent: re-running rewrites the same values. Rows are streamed in batches
so a large workspace doesn't build one giant transaction.

Revision ID: 099
Revises: 098
Create Date: 2026-08-20
"""
from __future__ import annotations

import json
import re

import sqlalchemy as sa
from alembic import op

revision = "099"
down_revision = "098"
branch_labels = None
depends_on = None

_BACKFILL_BATCH = 500

_TAG_RE = re.compile(r"<[^>]*>")
_WHITESPACE_RE = re.compile(r"\s+")


def extract_plain_text(content) -> str:
    """Frozen copy of the service-layer extractor — see module docstring."""
    if not content:
        return ""

    doc = None
    if isinstance(content, dict):
        if content.get("type") == "doc":
            doc = content
    else:
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("type") == "doc":
            doc = parsed

    if doc is None:
        raw = content if isinstance(content, str) else ""
        return _collapse(_TAG_RE.sub(" ", raw))

    parts: list[str] = []
    _collect_text(doc, parts)
    return _collapse(" ".join(parts))


def _collect_text(node: dict, parts: list) -> None:
    text = node.get("text")
    if text:
        parts.append(text)
    if node.get("type") == "mention":
        label = (node.get("attrs") or {}).get("label")
        if isinstance(label, str):
            parts.append(f"@{label}")
    for child in node.get("content") or []:
        if isinstance(child, dict):
            _collect_text(child, parts)


def _collapse(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()


def upgrade() -> None:
    op.add_column("notes", sa.Column("content_text", sa.Text(), nullable=True))

    bind = op.get_bind()
    # Untyped columns — let the connection's dialect handle bind types (PG UUID
    # in prod, String under SQLite), matching migration 056's approach.
    notes = sa.table("notes", sa.column("id"), sa.column("content"), sa.column("content_text"))

    offset = 0
    while True:
        rows = bind.execute(
            sa.select(notes.c.id, notes.c.content)
            .order_by(notes.c.id)
            .limit(_BACKFILL_BATCH)
            .offset(offset)
        ).fetchall()
        if not rows:
            break
        for note_id, content in rows:
            bind.execute(
                notes.update()
                .where(notes.c.id == note_id)
                .values(content_text=extract_plain_text(content))
            )
        offset += len(rows)

    # A partial index would be ideal but the search predicate is
    # `lower(content_text) LIKE '%needle%'` — a leading wildcard no btree can
    # serve. Left unindexed on purpose: at current note volumes the seq scan is
    # cheap, and the honest fix when it isn't is a GIN trigram index, which is
    # a separate decision (pg_trgm extension) rather than a silent add here.


def downgrade() -> None:
    op.drop_column("notes", "content_text")
