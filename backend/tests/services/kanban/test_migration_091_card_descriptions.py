# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Spec for migration 091's card-description backfill (editor P0-3).

Mirror of the 056 notes backfill pair (tests/services/notes/
test_content_normalizer_backfill.py + test_migration_056_e2e.py): the
091 migration walks every card row and rewrites non-canonical
descriptions through `normalize_note_content`, following the 056 recipe —
stream rows, skip empty, skip already-canonical doc-shaped JSON, else
normalize. Idempotent by construction (the canonical check short-circuits
the second run).
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from unittest.mock import patch

import sqlalchemy as sa


_MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "alembic"
    / "versions"
    / "091_normalize_card_descriptions.py"
)


def _load_migration():
    spec = importlib.util.spec_from_file_location("migration_091", _MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules["migration_091"] = module
    spec.loader.exec_module(module)
    return module


# --- _is_canonical classification (the four legacy shapes) -------------------


def test_is_canonical_recognizes_pm_doc():
    mig = _load_migration()
    pm = json.dumps({"type": "doc", "content": []})
    assert mig._is_canonical(pm) is True


def test_is_canonical_rejects_markdown():
    mig = _load_migration()
    assert mig._is_canonical("# Heading") is False


def test_is_canonical_rejects_plain_text():
    mig = _load_migration()
    assert mig._is_canonical("just some words") is False


def test_is_canonical_rejects_non_doc_json():
    mig = _load_migration()
    assert mig._is_canonical(json.dumps({"type": "paragraph"})) is False


def test_is_canonical_rejects_empty_and_none():
    mig = _load_migration()
    assert mig._is_canonical("") is False
    assert mig._is_canonical(None) is False  # type: ignore[arg-type]


# --- upgrade() end-to-end on mixed legacy rows -------------------------------


def _make_cards_table(engine: sa.Engine) -> sa.Table:
    cards = sa.Table(
        "cards",
        sa.MetaData(),
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("description", sa.Text),
    )
    cards.metadata.create_all(engine)
    return cards


def test_upgrade_normalizes_legacy_card_descriptions(tmp_path):
    db_path = tmp_path / "test.db"
    engine = sa.create_engine(f"sqlite:///{db_path}")
    cards = _make_cards_table(engine)

    canonical = json.dumps({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "content": [{"type": "text", "text": "already"}],
        }],
    })
    seeds = [
        ("md", "# Goal\n\n- item"),
        ("md_table", "# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"),
        ("plain", "just some words"),
        ("canonical", canonical),
        ("empty", ""),
    ]
    with engine.begin() as conn:
        for cid, description in seeds:
            conn.execute(cards.insert().values(id=cid, description=description))

    mig = _load_migration()
    with engine.begin() as conn:
        # mig.upgrade() calls op.get_bind() and constructs its own table
        # reference by name; the table exists in our DB so this is fine.
        with patch.object(mig.op, "get_bind", return_value=conn):
            mig.upgrade()

    with engine.begin() as conn:
        rows = {
            r.id: r.description
            for r in conn.execute(
                sa.select(cards.c.id, cards.c.description)
            ).fetchall()
        }

    md_doc = json.loads(rows["md"])
    assert md_doc["type"] == "doc"
    assert md_doc["content"][0]["type"] == "heading"
    assert md_doc["content"][1]["type"] == "bulletList"

    table_doc = json.loads(rows["md_table"])
    table = next(n for n in table_doc["content"] if n["type"] == "table")
    header_cells = table["content"][0]["content"]
    assert header_cells[0]["type"] == "tableHeader"

    plain_doc = json.loads(rows["plain"])
    assert plain_doc["content"][0]["content"][0]["text"] == "just some words"

    # Already-canonical row left structurally identical (JSON re-encoding
    # ok — content is unchanged, even if key order differs).
    assert json.loads(rows["canonical"]) == json.loads(canonical)

    # Empty description short-circuits — left "", not turned into a doc.
    assert rows["empty"] == ""

    engine.dispose()


def test_upgrade_is_idempotent(tmp_path):
    """Running the migration twice produces the same descriptions as once."""
    mig = _load_migration()
    db_path = tmp_path / "test.db"
    engine = sa.create_engine(f"sqlite:///{db_path}")
    cards = _make_cards_table(engine)

    with engine.begin() as conn:
        conn.execute(cards.insert().values(id="md", description="# Goal"))

    with engine.begin() as conn:
        with patch.object(mig.op, "get_bind", return_value=conn):
            mig.upgrade()
    with engine.begin() as conn:
        first = conn.execute(sa.select(cards.c.description)).scalar_one()

    with engine.begin() as conn:
        with patch.object(mig.op, "get_bind", return_value=conn):
            mig.upgrade()
    with engine.begin() as conn:
        second = conn.execute(sa.select(cards.c.description)).scalar_one()

    assert json.loads(first) == json.loads(second)
    engine.dispose()
