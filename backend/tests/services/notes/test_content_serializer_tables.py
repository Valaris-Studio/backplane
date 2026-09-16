# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Spec for GFM pipe-table emission in the ProseMirror → Markdown serializer.

Pins the editor P0-1 bug's read side: `_serialize_block` has no table case, so
a stored PM table doc falls into the unknown-block fallback and serializes to
nothing — the `?format=markdown` read silently loses the table.

Contract pinned here:
  - table → GFM pipes: header row, `| --- |` separator, body rows.
  - literal `|` inside a cell escapes to `\\|` so the table doesn't corrupt.
  - a table whose first row has no tableHeader cells still emits the separator
    after row one (GFM requires a header; gaining header-ness is the pinned
    degradation).
  - multi-block cells join with a single space (GFM cells are single-line).
  - round-trip with the normalizer is stable (the card's DoD).
"""
from __future__ import annotations

import json
from typing import Any

from app.services.notes.content_normalizer import normalize_note_content
from app.services.notes.content_serializer import prosemirror_to_markdown

_TABLE_MD = "| A | B |\n| --- | --- |\n| 1 | 2 |"

_CELL_ATTRS = {"colspan": 1, "rowspan": 1, "colwidth": None}


def _paragraph(text: str) -> dict[str, Any]:
    return {"type": "paragraph", "content": [{"type": "text", "text": text}]}


def _cell(kind: str, *blocks: dict[str, Any]) -> dict[str, Any]:
    return {"type": kind, "attrs": dict(_CELL_ATTRS), "content": list(blocks)}


def _row(*cells: dict[str, Any]) -> dict[str, Any]:
    return {"type": "tableRow", "content": list(cells)}


def _table(*rows: dict[str, Any]) -> dict[str, Any]:
    return {"type": "table", "content": list(rows)}


def _doc(*content: dict[str, Any]) -> str:
    return json.dumps({"type": "doc", "content": list(content)})


# Exact tree tiptap 3.20.2 produces for _TABLE_MD — the canonical contract.
_CANONICAL_TABLE_DOC = _doc(
    _table(
        _row(
            _cell("tableHeader", _paragraph("A")),
            _cell("tableHeader", _paragraph("B")),
        ),
        _row(
            _cell("tableCell", _paragraph("1")),
            _cell("tableCell", _paragraph("2")),
        ),
    )
)


def _collect_node_types(node: dict[str, Any]) -> list[str]:
    types = [node.get("type", "")]
    for child in node.get("content", []):
        types.extend(_collect_node_types(child))
    return types


def test_serialize_table_emits_gfm_pipes():
    assert prosemirror_to_markdown(_CANONICAL_TABLE_DOC) == _TABLE_MD


def test_serialize_escapes_pipes_in_cells():
    doc = _doc(
        _table(
            _row(_cell("tableHeader", _paragraph("H"))),
            _row(_cell("tableCell", _paragraph("a|b"))),
        )
    )
    assert prosemirror_to_markdown(doc) == "| H |\n| --- |\n| a\\|b |"


def test_serialize_table_without_header_row_still_emits_separator():
    doc = _doc(
        _table(
            _row(
                _cell("tableCell", _paragraph("A")),
                _cell("tableCell", _paragraph("B")),
            ),
            _row(
                _cell("tableCell", _paragraph("1")),
                _cell("tableCell", _paragraph("2")),
            ),
        )
    )
    assert prosemirror_to_markdown(doc) == _TABLE_MD


def test_serialize_multiblock_cell_joins_with_space():
    doc = _doc(
        _table(
            _row(
                _cell("tableHeader", _paragraph("H1")),
                _cell("tableHeader", _paragraph("H2")),
            ),
            _row(
                _cell("tableCell", _paragraph("x"), _paragraph("y")),
                _cell("tableCell", _paragraph("z")),
            ),
        )
    )
    assert prosemirror_to_markdown(doc) == "| H1 | H2 |\n| --- | --- |\n| x y | z |"


def test_roundtrip_markdown_table_is_stable():
    doc1 = json.loads(normalize_note_content(_TABLE_MD))
    # The DoD round-trip is only meaningful once the normalizer emits a real
    # table node — a paragraph-degraded doc would round-trip vacuously.
    assert "table" in _collect_node_types(doc1)
    md2 = prosemirror_to_markdown(doc1)
    assert "| A | B |" in md2
    doc2 = json.loads(normalize_note_content(md2))
    assert doc1 == doc2


def test_serialize_non_table_document_unchanged():
    # Guard: adding table emission must not disturb the existing vocabulary.
    doc = _doc(
        {"type": "heading", "attrs": {"level": 1}, "content": [
            {"type": "text", "text": "Title"}
        ]},
        _paragraph("body text"),
        {
            "type": "bulletList",
            "content": [
                {"type": "listItem", "content": [_paragraph("first")]},
                {"type": "listItem", "content": [_paragraph("second")]},
            ],
        },
    )
    assert prosemirror_to_markdown(doc) == (
        "# Title\n\nbody text\n\n- first\n- second"
    )
