# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""End-to-end check for migration 056's upgrade body.

We invoke the migration's upgrade() against a real sqlite DB seeded with
representative legacy rows. To bypass alembic's async env.py wiring, we
build the schema with `Base.metadata.create_all` and patch `op.get_bind`
to return our sync connection.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import pytest
import sqlalchemy as sa


def _load_migration():
    path = (
        Path(__file__).resolve().parents[3]
        / "alembic"
        / "versions"
        / "056_normalize_note_content.py"
    )
    spec = importlib.util.spec_from_file_location("migration_056_e2e", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["migration_056_e2e"] = module
    spec.loader.exec_module(module)
    return module


def test_upgrade_normalizes_legacy_rows(tmp_path):
    db_path = tmp_path / "test.db"
    engine = sa.create_engine(f"sqlite:///{db_path}")

    notes = sa.Table(
        "notes",
        sa.MetaData(),
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("content", sa.Text),
    )
    notes.metadata.create_all(engine)

    canonical = json.dumps({
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "content": [{"type": "text", "text": "already"}],
        }],
    })
    seeds = [
        ("md", "# heading\n\n- a\n- b"),
        ("plain", "just some words"),
        ("canonical", canonical),
        ("empty", ""),
        ("html", "<h1>hi</h1>"),
    ]
    with engine.begin() as conn:
        for nid, c in seeds:
            conn.execute(notes.insert().values(id=nid, content=c))

    mig = _load_migration()
    with engine.begin() as conn:
        # mig.upgrade() calls op.get_bind() and constructs its own table
        # reference by name; the table exists in our DB so this is fine.
        with patch.object(mig.op, "get_bind", return_value=conn):
            mig.upgrade()

    with engine.begin() as conn:
        rows = {
            r.id: r.content
            for r in conn.execute(sa.select(notes.c.id, notes.c.content)).fetchall()
        }

    md_doc = json.loads(rows["md"])
    assert md_doc["type"] == "doc"
    assert md_doc["content"][0]["type"] == "heading"
    assert md_doc["content"][1]["type"] == "bulletList"

    plain_doc = json.loads(rows["plain"])
    assert plain_doc["content"][0]["content"][0]["text"] == "just some words"

    html_doc = json.loads(rows["html"])
    assert html_doc["content"][0]["type"] == "heading"

    # Already-canonical row left structurally identical (JSON re-encoding
    # ok — content is unchanged, even if key order differs).
    assert json.loads(rows["canonical"]) == json.loads(canonical)

    # Empty content short-circuits — left empty, not turned into a doc.
    assert rows["empty"] == ""

    engine.dispose()


def test_upgrade_is_idempotent(tmp_path):
    """Running the migration twice produces the same content as once."""
    mig = _load_migration()
    db_path = tmp_path / "test.db"
    engine = sa.create_engine(f"sqlite:///{db_path}")
    notes = sa.Table(
        "notes",
        sa.MetaData(),
        sa.Column("id", sa.String, primary_key=True),
        sa.Column("content", sa.Text),
    )
    notes.metadata.create_all(engine)

    with engine.begin() as conn:
        conn.execute(notes.insert().values(id="md", content="# heading"))

    with engine.begin() as conn:
        with patch.object(mig.op, "get_bind", return_value=conn):
            mig.upgrade()
    with engine.begin() as conn:
        first = conn.execute(sa.select(notes.c.content)).scalar_one()

    with engine.begin() as conn:
        with patch.object(mig.op, "get_bind", return_value=conn):
            mig.upgrade()
    with engine.begin() as conn:
        second = conn.execute(sa.select(notes.c.content)).scalar_one()

    assert json.loads(first) == json.loads(second)
    engine.dispose()
