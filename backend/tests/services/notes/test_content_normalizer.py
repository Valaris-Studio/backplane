# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Spec for the note content normalizer.

Goal: every value the API accepts as `content` is normalized to a canonical
ProseMirror JSON document string before storage. Renderers (TipTap on the
frontend) then never have to guess the format.

Accepted inputs:
- ProseMirror dict (`{"type": "doc", ...}`)
- ProseMirror JSON string (same, serialized)
- HTML string (`<h1>foo</h1>`)
- Markdown string (the common-case agent input that exposed the original bug)
- Plain text
- None / empty string

Rejected inputs raise `InvalidContentError` so the API can surface 422.
"""
from __future__ import annotations

import json

import pytest

from app.services.notes.content_normalizer import (
    InvalidContentError,
    normalize_note_content,
)


def _as_doc(normalized: str) -> dict:
    parsed = json.loads(normalized)
    assert parsed["type"] == "doc"
    return parsed


def test_normalize_empty_string_returns_empty_doc():
    result = normalize_note_content("")
    doc = _as_doc(result)
    assert doc == {"type": "doc", "content": []}


def test_normalize_none_returns_empty_doc():
    result = normalize_note_content(None)
    doc = _as_doc(result)
    assert doc == {"type": "doc", "content": []}


def test_normalize_prosemirror_dict_passes_through():
    pm = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}
        ],
    }
    result = normalize_note_content(pm)
    assert json.loads(result) == pm


def test_normalize_prosemirror_json_string_passes_through():
    pm = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}
        ],
    }
    result = normalize_note_content(json.dumps(pm))
    assert json.loads(result) == pm


def test_normalize_markdown_heading_produces_heading_node():
    result = normalize_note_content("# Title")
    doc = _as_doc(result)
    assert doc["content"][0]["type"] == "heading"
    assert doc["content"][0]["attrs"]["level"] == 1
    assert doc["content"][0]["content"][0]["text"] == "Title"


def test_normalize_markdown_bullet_list_produces_list_nodes():
    result = normalize_note_content("- one\n- two\n")
    doc = _as_doc(result)
    assert doc["content"][0]["type"] == "bulletList"
    items = doc["content"][0]["content"]
    assert len(items) == 2
    assert items[0]["type"] == "listItem"


def test_normalize_markdown_ordered_list_produces_ordered_list():
    result = normalize_note_content("1. one\n2. two\n")
    doc = _as_doc(result)
    assert doc["content"][0]["type"] == "orderedList"
    assert len(doc["content"][0]["content"]) == 2


def test_normalize_markdown_bold_and_inline_code():
    result = normalize_note_content("**bold** and `code`")
    doc = _as_doc(result)
    paragraph = doc["content"][0]
    assert paragraph["type"] == "paragraph"
    text_nodes = paragraph["content"]
    bold = next(n for n in text_nodes if n.get("text") == "bold")
    assert any(m["type"] == "bold" for m in bold.get("marks", []))
    code = next(n for n in text_nodes if n.get("text") == "code")
    assert any(m["type"] == "code" for m in code.get("marks", []))


def test_normalize_markdown_link():
    result = normalize_note_content("[label](https://example.com)")
    doc = _as_doc(result)
    text_node = doc["content"][0]["content"][0]
    assert text_node["text"] == "label"
    link_mark = next(m for m in text_node["marks"] if m["type"] == "link")
    assert link_mark["attrs"]["href"] == "https://example.com"


def test_normalize_markdown_fenced_code_block():
    result = normalize_note_content("```python\nprint('hi')\n```\n")
    doc = _as_doc(result)
    code_block = doc["content"][0]
    assert code_block["type"] == "codeBlock"
    assert code_block["content"][0]["text"].rstrip() == "print('hi')"


def test_normalize_html_string_produces_structured_doc():
    result = normalize_note_content("<h1>Title</h1><p>Body</p>")
    doc = _as_doc(result)
    types = [node["type"] for node in doc["content"]]
    assert "heading" in types
    assert "paragraph" in types


# --- HTML path: inline marks and entity decoding ---------------------------
#
# The HTML path used to flatten every block's inner content with a bare
# tag-stripping regex: anchor hrefs vanished and HTML entities were stored as
# their literal source characters, which TipTap then rendered visibly.


def _text_nodes(node: dict) -> list[dict]:
    if node.get("type") == "text":
        return [node]
    collected: list[dict] = []
    for child in node.get("content", []):
        collected.extend(_text_nodes(child))
    return collected


def _find_link(node: dict, text: str) -> dict:
    for candidate in _text_nodes(node):
        if candidate.get("text") != text:
            continue
        for mark in candidate.get("marks", []):
            if mark["type"] == "link":
                return mark
    raise AssertionError(f"no link mark on text {text!r} in {node!r}")


def test_normalize_html_paragraph_keeps_anchor_href_and_decodes_entities():
    result = normalize_note_content(
        '<p><a href="https://x.example">docs</a> &amp; more</p>'
    )
    doc = _as_doc(result)
    paragraph = doc["content"][0]
    assert paragraph["type"] == "paragraph"
    assert _find_link(paragraph, "docs")["attrs"]["href"] == "https://x.example"
    assert "&" in "".join(n["text"] for n in _text_nodes(paragraph))
    assert "&amp;" not in "".join(n["text"] for n in _text_nodes(paragraph))


def test_normalize_html_heading_keeps_anchor_href():
    result = normalize_note_content('<h2>See <a href="/guide">the guide</a></h2>')
    doc = _as_doc(result)
    heading = doc["content"][0]
    assert heading["type"] == "heading"
    assert heading["attrs"]["level"] == 2
    assert _find_link(heading, "the guide")["attrs"]["href"] == "/guide"


def test_normalize_html_list_item_keeps_anchor_href():
    result = normalize_note_content(
        '<ul><li>first <a href="https://a.example">alpha</a></li>'
        "<li>second</li></ul>"
    )
    doc = _as_doc(result)
    bullet_list = doc["content"][0]
    assert bullet_list["type"] == "bulletList"
    assert len(bullet_list["content"]) == 2
    assert _find_link(bullet_list["content"][0], "alpha")["attrs"]["href"] == (
        "https://a.example"
    )


def test_normalize_html_keeps_inline_emphasis_marks():
    result = normalize_note_content(
        "<p><strong>bold</strong> and <em>italic</em> and <code>snippet</code></p>"
    )
    doc = _as_doc(result)
    nodes = _text_nodes(doc["content"][0])
    marks_for = {
        n["text"]: {m["type"] for m in n.get("marks", [])} for n in nodes
    }
    assert "bold" in marks_for["bold"]
    assert "italic" in marks_for["italic"]
    assert "code" in marks_for["snippet"]


@pytest.mark.parametrize(
    "block_html,expected_node_type",
    [
        ("<p>a &lt;b&gt; c &amp; d &quot;e&quot; &#65;</p>", "paragraph"),
        ("<h1>a &lt;b&gt; c &amp; d &quot;e&quot; &#65;</h1>", "heading"),
        ("<h3>a &lt;b&gt; c &amp; d &quot;e&quot; &#65;</h3>", "heading"),
        ("<blockquote>a &lt;b&gt; c &amp; d &quot;e&quot; &#65;</blockquote>", "blockquote"),
        ("<pre>a &lt;b&gt; c &amp; d &quot;e&quot; &#65;</pre>", "codeBlock"),
    ],
)
def test_normalize_html_decodes_entities_in_every_block_type(
    block_html: str, expected_node_type: str
):
    doc = _as_doc(normalize_note_content(block_html))
    assert doc["content"][0]["type"] == expected_node_type
    text = "".join(n["text"] for n in _text_nodes(doc["content"][0]))
    assert "a <b> c & d \"e\" A" in text


def test_normalize_html_decodes_entities_in_leading_and_trailing_text():
    doc = _as_doc(normalize_note_content("lead &amp; in<p>body</p>tail &lt;z&gt;"))
    texts = ["".join(n["text"] for n in _text_nodes(b)) for b in doc["content"]]
    assert "lead & in" in texts[0]
    assert "tail <z>" in texts[-1]


def test_normalize_html_entities_are_decoded_exactly_once():
    doc = _as_doc(normalize_note_content("<p>&amp;amp; stays escaped once</p>"))
    text = "".join(n["text"] for n in _text_nodes(doc["content"][0]))
    assert text.startswith("&amp; stays escaped once")


def test_normalize_html_list_item_decodes_entities():
    doc = _as_doc(normalize_note_content("<ol><li>x &amp; y</li></ol>"))
    ordered = doc["content"][0]
    assert ordered["type"] == "orderedList"
    assert "x & y" in "".join(n["text"] for n in _text_nodes(ordered))


def test_normalize_markdown_link_and_ampersand_unchanged_by_html_fix():
    doc = _as_doc(normalize_note_content("[label](https://example.com) & co"))
    paragraph = doc["content"][0]
    assert _find_link(paragraph, "label")["attrs"]["href"] == "https://example.com"
    assert "& co" in "".join(n["text"] for n in _text_nodes(paragraph))


# --- Dispatch: markdown that merely mentions a tag-shaped fragment ----------
#
# The dispatch predicate used to be "does any `<tag>`-shaped substring exist?",
# which sent whole markdown documents down the HTML path. Markdown has no HTML
# block structure, so the document collapsed to one paragraph of literal source
# and the bracketed fragment was dropped as an unknown tag. The probe pair below
# differs in exactly one variable — the presence of that fragment.

_MARKDOWN_PROBE = (
    "# Heading\n"
    "\n"
    "A paragraph with **bold** text.\n"
    "\n"
    "- bullet one\n"
    "- bullet two\n"
)

_MARKDOWN_PROBE_WITH_BRACKETS = (
    "# Heading\n"
    "\n"
    "A paragraph with **bold** text naming `runner-<name>.yaml`.\n"
    "\n"
    "- bullet one referencing `mcp-config-<slug>.json`\n"
    "- bullet two\n"
)


def _node_types(doc: dict) -> list[str]:
    return [node["type"] for node in doc["content"]]


def test_normalize_markdown_without_brackets_produces_typed_nodes():
    doc = _as_doc(normalize_note_content(_MARKDOWN_PROBE))
    assert _node_types(doc) == ["heading", "paragraph", "bulletList"]


def test_normalize_markdown_with_tag_shaped_fragment_still_parses_as_markdown():
    doc = _as_doc(normalize_note_content(_MARKDOWN_PROBE_WITH_BRACKETS))
    assert _node_types(doc) == _node_types(_as_doc(normalize_note_content(_MARKDOWN_PROBE)))


def test_normalize_markdown_keeps_tag_shaped_fragment_text():
    doc = _as_doc(normalize_note_content(_MARKDOWN_PROBE_WITH_BRACKETS))
    all_text = "".join(n["text"] for n in _text_nodes(doc))
    assert "runner-<name>.yaml" in all_text
    assert "mcp-config-<slug>.json" in all_text


@pytest.mark.parametrize(
    "fragment",
    ["<name>", "<T>", "2>&1 > <logfile>", "</close>", "<div>"],
)
def test_normalize_markdown_heading_survives_any_tag_shaped_fragment(fragment: str):
    doc = _as_doc(normalize_note_content(f"# Title\n\nMentions {fragment} inline.\n"))
    assert doc["content"][0]["type"] == "heading"


def test_normalize_markdown_with_brackets_keeps_links_and_single_decoding():
    doc = _as_doc(
        normalize_note_content(
            "See [docs](https://example.com) about `<slug>` &amp; more\n"
        )
    )
    paragraph = doc["content"][0]
    assert _find_link(paragraph, "docs")["attrs"]["href"] == "https://example.com"
    text = "".join(n["text"] for n in _text_nodes(paragraph))
    assert "<slug>" in text
    # CommonMark resolves entity references itself; the markdown path must not
    # add a second unescape pass on top of it.
    assert "& more" in text
    assert "&amp;" not in text


def test_normalize_plain_text_produces_single_paragraph():
    result = normalize_note_content("just some words")
    doc = _as_doc(result)
    assert len(doc["content"]) == 1
    assert doc["content"][0]["type"] == "paragraph"
    assert doc["content"][0]["content"][0]["text"] == "just some words"


def test_normalize_rejects_non_doc_dict():
    with pytest.raises(InvalidContentError):
        normalize_note_content({"type": "paragraph"})


def test_normalize_rejects_non_string_non_dict():
    with pytest.raises(InvalidContentError):
        normalize_note_content(12345)  # type: ignore[arg-type]


def test_normalize_is_idempotent():
    once = normalize_note_content("# Title\n\nBody")
    twice = normalize_note_content(once)
    assert json.loads(once) == json.loads(twice)


# --- Service-level integration: NoteService persists canonical PM JSON ---


async def test_create_note_stores_canonical_pm_json_for_markdown(
    db_session, test_workspace, test_board, test_user
):
    from app.schemas.notes.note import NoteCreate
    from app.services.notes.note import NoteService

    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(title="md", content="# Heading\n\n- a\n- b"),
        test_user.id,
        test_board.id,
    )

    stored = json.loads(note.content)
    assert stored["type"] == "doc"
    types = [n["type"] for n in stored["content"]]
    assert "heading" in types
    assert "bulletList" in types


async def test_create_note_accepts_pm_dict_via_schema(
    db_session, test_workspace, test_board, test_user
):
    from app.schemas.notes.note import NoteCreate
    from app.services.notes.note import NoteService

    pm = {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}
        ],
    }
    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id,
        NoteCreate(title="dict", content=pm),
        test_user.id,
        test_board.id,
    )

    assert json.loads(note.content) == pm


async def test_update_note_normalizes_markdown_content(
    db_session, test_workspace, test_user
):
    from app.schemas.notes.note import NoteCreate, NoteUpdate
    from app.services.notes.note import NoteService

    service = NoteService(db_session)
    note = await service.create_note(
        test_workspace.id, NoteCreate(title="t"), test_user.id
    )

    updated = await service.update_note(
        note.id,
        test_workspace.id,
        NoteUpdate(content="## Subhead"),
    )

    stored = json.loads(updated.content)
    assert stored["content"][0]["type"] == "heading"
    assert stored["content"][0]["attrs"]["level"] == 2
