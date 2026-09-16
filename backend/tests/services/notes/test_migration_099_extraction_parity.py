# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Migration 099 carries a frozen COPY of the plain-text extractor rather than
importing the service module (a migration is a historical record and must not
drift with the app). This test is the other half of that bargain: the copy and
the live extractor must agree today, so the backfill writes exactly what every
subsequent write path will write.

The SQLite test harness builds its schema from `Base.metadata.create_all`, not
from alembic, so the migration's SQL is not exercised here — only its
extraction logic, which is the part that decides what lands in the column.
"""
import importlib.util
import json
from pathlib import Path

import pytest

from app.services.notes.content_text import extract_plain_text

MIGRATION_PATH = (
    Path(__file__).resolve().parents[3]
    / "alembic"
    / "versions"
    / "099_add_notes_content_text.py"
)


def load_migration():
    spec = importlib.util.spec_from_file_location("migration_099", MIGRATION_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def migration():
    return load_migration()


def doc(blocks: list) -> str:
    return json.dumps({"type": "doc", "content": blocks})


def para(text: str) -> dict:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def corpus() -> list[str]:
    """Every shape a stored `content` value takes in the wild."""
    return [
        "",
        doc([]),
        doc([para("simple body")]),
        doc([para("first"), para("second")]),
        doc(
            [
                {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Title"}]},
                para("under the heading"),
            ]
        ),
        doc(
            [
                {
                    "type": "bulletList",
                    "content": [
                        {"type": "listItem", "content": [para("one")]},
                        {"type": "listItem", "content": [para("two")]},
                    ],
                }
            ]
        ),
        doc(
            [
                {
                    "type": "paragraph",
                    "content": [
                        {"type": "text", "text": "cc "},
                        {"type": "mention", "attrs": {"id": "u1", "label": "Ana"}},
                    ],
                }
            ]
        ),
        doc(
            [
                {
                    "type": "codeBlock",
                    "attrs": {"language": "go"},
                    "content": [{"type": "text", "text": "func main() {}"}],
                }
            ]
        ),
        doc([para("  whitespace \n\n runs  ")]),
        # Legacy rows written before the PM normalizer landed.
        "<p>legacy <b>html</b></p>",
        "raw markdown **body**",
        "{malformed json",
        '{"type": "paragraph"}',
    ]


@pytest.mark.parametrize("content", corpus())
def test_migration_extraction_matches_service_extraction(migration, content):
    assert migration.extract_plain_text(content) == extract_plain_text(content)


def test_migration_extraction_handles_null_content(migration):
    assert migration.extract_plain_text(None) == extract_plain_text(None) == ""


def test_migration_revision_chain(migration):
    assert migration.revision == "099"
    assert migration.down_revision == "098"
