# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Spec for markdown table support in the note content normalizer.

Pins the editor P0-1 bug: `_consume_blocks` has no `table_open` case, so a
markdown table written by an MCP agent falls into the unknown-block branch and
is silently dropped (and the `commonmark` preset does not even tokenize tables
— the source lines degrade to a plain paragraph instead of a table node).

The normalizer must emit EXACTLY the ProseMirror table shape TipTap 3.20.2
produces: table → tableRow → tableHeader/tableCell (each cell carrying
attrs {"colspan": 1, "rowspan": 1, "colwidth": None} and a paragraph child).
"""
from __future__ import annotations

import json
from typing import Any

from app.services.notes.content_normalizer import normalize_note_content

_TABLE_MD = "| A | B |\n| --- | --- |\n| 1 | 2 |"

_CELL_ATTRS = {"colspan": 1, "rowspan": 1, "colwidth": None}


def _cell(kind: str, text: str) -> dict[str, Any]:
    return {
        "type": kind,
        "attrs": dict(_CELL_ATTRS),
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": text}]}
        ],
    }


# Exact tree tiptap 3.20.2 produces for _TABLE_MD — the canonical contract.
_CANONICAL_TABLE_NODE: dict[str, Any] = {
    "type": "table",
    "content": [
        {
            "type": "tableRow",
            "content": [_cell("tableHeader", "A"), _cell("tableHeader", "B")],
        },
        {
            "type": "tableRow",
            "content": [_cell("tableCell", "1"), _cell("tableCell", "2")],
        },
    ],
}

_CANONICAL_TABLE_DOC: dict[str, Any] = {
    "type": "doc",
    "content": [_CANONICAL_TABLE_NODE],
}


def _as_doc(normalized: str) -> dict:
    parsed = json.loads(normalized)
    assert parsed["type"] == "doc"
    return parsed


def _collect_node_types(node: dict[str, Any]) -> list[str]:
    types = [node.get("type", "")]
    for child in node.get("content", []):
        types.extend(_collect_node_types(child))
    return types


def _find_table(doc: dict[str, Any]) -> dict[str, Any]:
    tables = [n for n in doc["content"] if n.get("type") == "table"]
    assert tables, (
        f"no table node in doc — top-level types: "
        f"{[n.get('type') for n in doc['content']]}"
    )
    return tables[0]


def test_normalize_markdown_table_emits_pm_table():
    doc = _as_doc(normalize_note_content(_TABLE_MD))
    assert doc == _CANONICAL_TABLE_DOC


def test_normalize_heading_plus_table():
    doc = _as_doc(normalize_note_content(f"# Title\n\n{_TABLE_MD}"))
    assert doc["content"][0]["type"] == "heading"
    assert doc["content"][0]["attrs"]["level"] == 1
    assert doc["content"][1] == _CANONICAL_TABLE_NODE


def test_normalize_table_cell_inline_marks():
    doc = _as_doc(
        normalize_note_content("| A |\n| --- |\n| **bold** cell |")
    )
    table = _find_table(doc)
    body_row = table["content"][1]
    cell_paragraph = body_row["content"][0]["content"][0]
    assert cell_paragraph["type"] == "paragraph"
    bold_run = next(
        (n for n in cell_paragraph["content"] if n.get("text") == "bold"), None
    )
    assert bold_run is not None, f"no 'bold' text run in {cell_paragraph!r}"
    assert any(m["type"] == "bold" for m in bold_run.get("marks", []))


def test_normalize_table_followed_by_paragraph():
    # Guards the token-consumption index math: an off-by-one after the table's
    # close token would swallow the trailing block.
    doc = _as_doc(normalize_note_content(f"{_TABLE_MD}\n\nafter the table"))
    assert doc["content"][0] == _CANONICAL_TABLE_NODE
    trailing = doc["content"][1]
    assert trailing["type"] == "paragraph"
    assert trailing["content"][0]["text"] == "after the table"


def test_normalize_table_is_not_silently_dropped():
    # The anti-drop pin: today the table degrades to a paragraph of raw source
    # (or, once tokenized without a table_open case, vanishes entirely).
    # Either failure mode leaves no "table" node in the doc.
    doc = _as_doc(normalize_note_content(_TABLE_MD))
    assert "table" in _collect_node_types(doc)
