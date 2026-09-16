# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Plain-text projection of a note's PM content — the backend twin of the
frontend's `extractPlainText` (frontend/src/lib/text-utils.ts).

Both feed the same two features (search needle + list preview), so a drift
between them means a note the UI previews one way is searched another.
"""
import json

from app.services.notes.content_text import extract_plain_text


def _doc(*blocks) -> str:
    return json.dumps({"type": "doc", "content": list(blocks)})


def _para(*texts) -> dict:
    return {
        "type": "paragraph",
        "content": [{"type": "text", "text": t} for t in texts],
    }


def test_extract_empty_content_is_empty_string():
    assert extract_plain_text("") == ""
    assert extract_plain_text(None) == ""


def test_extract_concatenates_text_nodes_with_spaces():
    assert extract_plain_text(_doc(_para("Hello", " world"))) == "Hello world"


def test_extract_separates_blocks_with_whitespace():
    text = extract_plain_text(_doc(_para("First block"), _para("Second block")))
    assert text == "First block Second block"


def test_extract_collapses_runs_of_whitespace():
    assert extract_plain_text(_doc(_para("a   \n\t b"))) == "a b"


def test_extract_strips_markup_and_json_syntax():
    """The whole point: no braces, no node type names, no attribute keys."""
    doc = _doc(
        {
            "type": "heading",
            "attrs": {"level": 2},
            "content": [{"type": "text", "text": "Deploy notes"}],
        },
        _para("body text"),
    )
    text = extract_plain_text(doc)
    assert text == "Deploy notes body text"
    for forbidden in ("{", "}", "type", "heading", "attrs", "level"):
        assert forbidden not in text


def test_extract_walks_nested_lists():
    doc = _doc(
        {
            "type": "bulletList",
            "content": [
                {"type": "listItem", "content": [_para("one")]},
                {"type": "listItem", "content": [_para("two")]},
            ],
        }
    )
    assert extract_plain_text(doc) == "one two"


def test_extract_surfaces_mention_label_with_at_sign():
    """Mirrors extractPlainText: a mention is an atom with no text child, so
    its label is surfaced as '@Label' or searching for a person finds nothing."""
    doc = _doc(
        {
            "type": "paragraph",
            "content": [
                {"type": "text", "text": "ping "},
                {"type": "mention", "attrs": {"id": "u1", "label": "Ana"}},
            ],
        }
    )
    assert extract_plain_text(doc) == "ping @Ana"


def test_extract_reads_code_blocks():
    doc = _doc(
        {
            "type": "codeBlock",
            "attrs": {"language": "python"},
            "content": [{"type": "text", "text": "print('hi')"}],
        }
    )
    assert extract_plain_text(doc) == "print('hi')"


def test_extract_falls_back_to_stripped_html_for_legacy_content():
    """Rows written before the PM normalizer hold raw HTML/markdown."""
    assert extract_plain_text("<p>legacy <b>html</b></p>") == "legacy html"


def test_extract_falls_back_to_raw_string_for_plain_text():
    assert extract_plain_text("just plain text") == "just plain text"


def test_extract_handles_malformed_json():
    assert extract_plain_text("{not json at all") == "{not json at all"


def test_extract_handles_non_doc_json():
    assert extract_plain_text('{"type": "paragraph"}') == '{"type": "paragraph"}'


def test_extract_does_not_truncate():
    """Truncation is the preview's job; content_text stores the full text so
    search can match a word past the 200-char mark."""
    long_text = "word " * 200
    assert len(extract_plain_text(_doc(_para(long_text)))) > 200


def test_build_preview_truncates_at_limit():
    from app.services.notes.content_text import build_preview

    doc = _doc(_para("x" * 500))
    preview = build_preview(doc)
    assert len(preview) == 200
    assert preview == "x" * 200


def test_build_preview_short_text_untouched():
    from app.services.notes.content_text import build_preview

    assert build_preview(_doc(_para("short"))) == "short"


def test_build_preview_prefers_stored_content_text():
    """When content_text is already maintained we must not re-parse the PM
    doc — that's the whole cost the column exists to avoid."""
    from app.services.notes.content_text import build_preview

    assert build_preview(_doc(_para("from json")), content_text="from column") == "from column"


def test_build_preview_falls_back_when_content_text_is_null():
    """Rolling deploy: rows written by old code have NULL content_text."""
    from app.services.notes.content_text import build_preview

    assert build_preview(_doc(_para("from json")), content_text=None) == "from json"
