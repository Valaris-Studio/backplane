# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Spec for the ProseMirror → Markdown serializer.

This is the REVERSE of content_normalizer.normalize_note_content (markdown → PM).
The node/mark vocabulary is a CLOSED set that must mirror the normalizer exactly:
  Nodes: doc, paragraph, heading(1-3), bulletList, orderedList(start), listItem,
         codeBlock(language), blockquote, horizontalRule, hardBreak, text.
  Marks: bold(**), italic(*), strike(~~), code(`), link([text](href)).

The ROUND-TRIP class is the robust contract check: normalize(md) → PM, then
prosemirror_to_markdown(PM) → md', and re-normalizing md' must yield the SAME
PM doc. We compare PM docs (not raw strings) to avoid whitespace/formatting
flakiness that is semantically irrelevant.
"""
from __future__ import annotations

import json

from app.services.notes.content_normalizer import normalize_note_content
from app.services.notes.content_serializer import prosemirror_to_markdown


def _doc(*content: dict) -> str:
    return json.dumps({"type": "doc", "content": list(content)})


def _text(text: str, marks: list[dict] | None = None) -> dict:
    node: dict = {"type": "text", "text": text}
    if marks:
        node["marks"] = marks
    return node


# --- Per-node ---------------------------------------------------------------


def test_paragraph_serializes_to_plain_text():
    doc = _doc({"type": "paragraph", "content": [_text("hello world")]})
    assert prosemirror_to_markdown(doc) == "hello world"


def test_heading_level_1_serializes_with_one_hash():
    doc = _doc(
        {"type": "heading", "attrs": {"level": 1}, "content": [_text("Title")]}
    )
    assert prosemirror_to_markdown(doc) == "# Title"


def test_heading_level_3_serializes_with_three_hashes():
    doc = _doc(
        {"type": "heading", "attrs": {"level": 3}, "content": [_text("Sub")]}
    )
    assert prosemirror_to_markdown(doc) == "### Sub"


def test_bullet_list_serializes_with_dash_markers():
    doc = _doc(
        {
            "type": "bulletList",
            "content": [
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [_text("first")]}
                    ],
                },
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [_text("second")]}
                    ],
                },
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "- first\n- second"


def test_ordered_list_serializes_with_numeric_markers():
    doc = _doc(
        {
            "type": "orderedList",
            "content": [
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [_text("one")]}
                    ],
                },
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [_text("two")]}
                    ],
                },
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "1. one\n2. two"


def test_ordered_list_honors_start_attr():
    doc = _doc(
        {
            "type": "orderedList",
            "attrs": {"start": 5},
            "content": [
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [_text("five")]}
                    ],
                },
                {
                    "type": "listItem",
                    "content": [
                        {"type": "paragraph", "content": [_text("six")]}
                    ],
                },
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "5. five\n6. six"


def test_code_block_serializes_with_fence_and_language():
    doc = _doc(
        {
            "type": "codeBlock",
            "attrs": {"language": "python"},
            "content": [_text("print('hi')")],
        }
    )
    assert prosemirror_to_markdown(doc) == "```python\nprint('hi')\n```"


def test_code_block_without_language_uses_bare_fence():
    doc = _doc(
        {"type": "codeBlock", "content": [_text("plain code")]}
    )
    assert prosemirror_to_markdown(doc) == "```\nplain code\n```"


def test_blockquote_prefixes_each_line():
    doc = _doc(
        {
            "type": "blockquote",
            "content": [
                {"type": "paragraph", "content": [_text("quoted line")]}
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "> quoted line"


def test_horizontal_rule_serializes_to_three_dashes():
    doc = _doc({"type": "horizontalRule"})
    assert prosemirror_to_markdown(doc) == "---"


def test_hard_break_serializes_to_two_spaces_newline():
    doc = _doc(
        {
            "type": "paragraph",
            "content": [_text("line1"), {"type": "hardBreak"}, _text("line2")],
        }
    )
    assert prosemirror_to_markdown(doc) == "line1  \nline2"


# --- Per-mark ---------------------------------------------------------------


def test_bold_mark_wraps_in_double_asterisks():
    doc = _doc(
        {"type": "paragraph", "content": [_text("bold", [{"type": "bold"}])]}
    )
    assert prosemirror_to_markdown(doc) == "**bold**"


def test_italic_mark_wraps_in_single_asterisks():
    doc = _doc(
        {"type": "paragraph", "content": [_text("em", [{"type": "italic"}])]}
    )
    assert prosemirror_to_markdown(doc) == "*em*"


def test_strike_mark_wraps_in_double_tildes():
    doc = _doc(
        {"type": "paragraph", "content": [_text("gone", [{"type": "strike"}])]}
    )
    assert prosemirror_to_markdown(doc) == "~~gone~~"


def test_code_mark_wraps_in_backticks():
    doc = _doc(
        {"type": "paragraph", "content": [_text("x = 1", [{"type": "code"}])]}
    )
    assert prosemirror_to_markdown(doc) == "`x = 1`"


def test_link_mark_serializes_to_markdown_link():
    doc = _doc(
        {
            "type": "paragraph",
            "content": [
                _text(
                    "site",
                    [{"type": "link", "attrs": {"href": "https://x.io"}}],
                )
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "[site](https://x.io)"


def test_code_mark_sits_inside_emphasis_so_the_pair_round_trips():
    # Either mark order in the PM node → code innermost. `` `**v**` `` would
    # re-parse as a code span containing the literal characters `**v**`.
    doc = _doc(
        {
            "type": "paragraph",
            "content": [
                _text("v", [{"type": "bold"}, {"type": "code"}])
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "**`v`**"


def test_adjacent_nodes_with_different_marks_each_close_their_own():
    # Coalescing may only keep a mark open when the neighbour carries the SAME
    # mark. Matching on position alone would leave bold open across the italic
    # node and emit `**a*b***`.
    doc = _doc(
        {
            "type": "paragraph",
            "content": [
                _text("a", [{"type": "bold"}]),
                _text("b", [{"type": "italic"}]),
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "**a***b*"


def test_adjacent_links_with_different_hrefs_are_not_merged():
    # Same mark TYPE, different attrs — the href is part of the mark's
    # identity, so the first link must close before the second opens.
    doc = _doc(
        {
            "type": "paragraph",
            "content": [
                _text("x", [{"type": "link", "attrs": {"href": "https://a"}}]),
                _text("y", [{"type": "link", "attrs": {"href": "https://b"}}]),
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "[x](https://a)[y](https://b)"


def test_sibling_paragraphs_in_a_list_item_keep_their_blank_line_separator():
    # Only a nested LIST tightens against its lead-in paragraph. Two ordinary
    # paragraphs are separate blocks; dropping the blank line would merge them
    # into one paragraph on re-parse.
    doc = _doc(
        {
            "type": "bulletList",
            "content": [
                {
                    "type": "listItem",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "first"}],
                        },
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": "second"}],
                        },
                    ],
                }
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "- first\n  \n  second"


def test_a_mark_spanning_sibling_nodes_opens_and_closes_once():
    # Bold runs across all three nodes; emitting each node independently would
    # close and reopen it (`**text ****`code`**** text**`), and the adjacent
    # `****` pairs re-parse as literal asterisks.
    doc = _doc(
        {
            "type": "paragraph",
            "content": [
                _text("text ", [{"type": "bold"}]),
                _text("code", [{"type": "bold"}, {"type": "code"}]),
                _text(" text", [{"type": "bold"}]),
            ],
        }
    )
    assert prosemirror_to_markdown(doc) == "**text `code` text**"


# --- Degradation ------------------------------------------------------------


def test_non_pm_plain_string_degrades_to_stripped_text():
    assert prosemirror_to_markdown("just plain text") == "just plain text"


def test_legacy_html_string_never_emits_raw_html():
    out = prosemirror_to_markdown("<p>hello <b>world</b></p>")
    assert "<" not in out
    assert "hello" in out and "world" in out


def test_invalid_json_string_degrades_gracefully():
    out = prosemirror_to_markdown("{not valid json")
    assert "<" not in out


def test_accepts_dict_input_directly():
    doc = {"type": "doc", "content": [{"type": "paragraph", "content": [_text("d")]}]}
    assert prosemirror_to_markdown(doc) == "d"


def test_empty_doc_serializes_to_empty_string():
    assert prosemirror_to_markdown(_doc()) == ""


# --- Round-trip contract ----------------------------------------------------


def _renormalize(md: str) -> dict:
    """normalize → PM doc dict (the canonical comparison form)."""
    return json.loads(normalize_note_content(md))


class TestRoundTrip:
    """normalize(md) → serialize → re-normalize == normalize(md).

    Comparing the two PM docs (not the raw markdown strings) is the robust
    semantic-equality check: whitespace/marker-formatting differences that
    re-normalize to the identical tree are treated as equal.
    """

    def _assert_round_trip(self, md: str) -> None:
        pm_from_source = normalize_note_content(md)
        serialized = prosemirror_to_markdown(pm_from_source)
        # Re-normalizing the serialized markdown must reproduce the same PM doc.
        assert _renormalize(serialized) == json.loads(pm_from_source)

    def test_round_trip_heading(self):
        self._assert_round_trip("# A Heading")

    def test_round_trip_paragraph(self):
        self._assert_round_trip("Just a paragraph of text.")

    def test_round_trip_bold(self):
        self._assert_round_trip("This is **bold** text.")

    def test_round_trip_italic(self):
        self._assert_round_trip("This is *italic* text.")

    def test_round_trip_strike(self):
        self._assert_round_trip("This is ~~struck~~ text.")

    def test_round_trip_inline_code(self):
        self._assert_round_trip("Use the `foo()` call.")

    def test_round_trip_link(self):
        self._assert_round_trip("See [the docs](https://example.com/docs).")

    def test_round_trip_bullet_list(self):
        self._assert_round_trip("- alpha\n- beta\n- gamma")

    def test_round_trip_ordered_list(self):
        self._assert_round_trip("1. first\n2. second\n3. third")

    def test_round_trip_code_block(self):
        self._assert_round_trip("```python\nx = 1\nprint(x)\n```")

    def test_round_trip_blockquote(self):
        self._assert_round_trip("> a quoted thought")

    def test_round_trip_horizontal_rule(self):
        self._assert_round_trip("before\n\n---\n\nafter")

    def test_round_trip_multi_block_document(self):
        md = (
            "# Title\n\n"
            "An intro **paragraph** with a [link](https://x.io).\n\n"
            "## Details\n\n"
            "- one\n- two\n\n"
            "```js\nconst a = 1;\n```\n\n"
            "> quoted"
        )
        self._assert_round_trip(md)

    # The brief flagged these two as the tricky cases: markdown emphasis
    # adjacent to parenthesized text. The bug worry is that a naive serializer
    # would mis-place asterisks/parens and re-normalize to a different tree.
    def test_round_trip_bold_immediately_followed_by_parenthetical(self):
        self._assert_round_trip("**bold**(text)")

    def test_round_trip_bold_word_then_space_then_parenthetical(self):
        self._assert_round_trip("see **FCP** (mechanism)")


class TestHtmlInputFidelity:
    """HTML input must survive normalize → markdown export intact.

    HTML entities decode to literal characters and anchor hrefs become link
    marks, so the markdown export carries both instead of losing the href and
    printing `&amp;` verbatim.
    """

    def test_html_anchor_survives_markdown_export(self):
        pm = normalize_note_content('<p>Read <a href="https://x.example">docs</a>.</p>')
        assert "[docs](https://x.example)" in prosemirror_to_markdown(pm)

    def test_html_entity_exports_as_literal_character(self):
        pm = normalize_note_content("<p>Ben &amp; Jerry &lt;tag&gt;</p>")
        exported = prosemirror_to_markdown(pm)
        assert "Ben & Jerry <tag>" in exported
        assert "&amp;" not in exported

    def test_html_link_and_entity_survive_re_normalization(self):
        pm = normalize_note_content(
            '<p><a href="https://x.example">docs</a> &amp; more</p>'
        )
        assert _renormalize(prosemirror_to_markdown(pm)) == json.loads(pm)
