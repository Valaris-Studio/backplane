# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Checklists (TipTap taskList/taskItem) survive every input shape and a round trip.

Obstacle #10: `- [ ] task` used to land as the literal text "[ ] task". The
markdown form pinned here is the contract both serializers emit and both
parsers read:

    - [ ] open item
    - [x] done item
      - [ ] nested item      (two-space indent, the `- ` marker width)

A bullet list is a checklist only when EVERY item starts with `[ ]`/`[x]`; a
mixed list stays a bullet list with the brackets as text. An escaped `\\[ ]`
is the way to write a literal bracket item.
"""
from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

from app.services.media.links import MediaLinkContext, canonicalize_rich_text
from app.services.notes.content_normalizer import normalize_note_content
from app.services.notes.content_serializer import prosemirror_to_markdown
from app.services.notes.media_markdown import strip_unsafe_media_text

WS = uuid.UUID("11111111-1111-4111-8111-111111111111")
OBJ = uuid.UUID("33333333-3333-4333-8333-333333333333")
BUCKET = "valaris-media"
STABLE_IMAGE = f"/api/workspaces/acme/media/{OBJ}/shot.png"
SIGNED_IMAGE = (
    f"https://storage.googleapis.com/{BUCKET}/media/{WS}/{OBJ}/shot.png"
    "?X-Goog-Expires=3600&X-Goog-Signature=abc123"
)


def doc(*nodes: dict) -> dict:
    return {"type": "doc", "content": list(nodes)}


def para(text: str | None = None, marks: list[dict] | None = None) -> dict:
    if text is None:
        return {"type": "paragraph"}
    run: dict[str, Any] = {"type": "text", "text": text}
    if marks:
        run["marks"] = marks
    return {"type": "paragraph", "content": [run]}


def task(text: str | None, checked: bool = False, *children: dict) -> dict:
    return {"type": "taskItem", "attrs": {"checked": checked}, "content": [para(text), *children]}


def task_list(*items: dict) -> dict:
    return {"type": "taskList", "content": list(items)}


def bullets(*texts: str) -> dict:
    return {"type": "bulletList", "content": [{"type": "listItem", "content": [para(t)]} for t in texts]}


def normalized(content: Any) -> dict:
    return json.loads(normalize_note_content(content))


# --- markdown → ProseMirror ---------------------------------------------------


def test_markdown_checklist_becomes_task_list() -> None:
    assert normalized("- [ ] write tests\n- [x] ship it") == doc(
        task_list(task("write tests"), task("ship it", True)),
    )


def test_markdown_uppercase_x_and_other_bullet_markers_are_checked() -> None:
    assert normalized("* [X] done\n* [ ] open") == doc(
        task_list(task("done", True), task("open")),
    )


def test_markdown_nested_checklist_keeps_its_tree() -> None:
    assert normalized("- [ ] parent\n  - [x] child\n  - [ ] sibling\n- [ ] next") == doc(
        task_list(
            task("parent", False, task_list(task("child", True), task("sibling"))),
            task("next"),
        ),
    )


def test_markdown_task_item_may_hold_a_plain_bullet_list() -> None:
    assert normalized("- [ ] parent\n  - plain child") == doc(
        task_list(task("parent", False, bullets("plain child"))),
    )


def test_markdown_checklist_nested_under_a_bullet_item() -> None:
    assert normalized("- parent\n  - [ ] todo") == doc(
        {
            "type": "bulletList",
            "content": [{"type": "listItem", "content": [para("parent"), task_list(task("todo"))]}],
        },
    )


def test_markdown_task_text_keeps_inline_marks() -> None:
    assert normalized("- [x] **bold** done") == doc(
        task_list({
            "type": "taskItem",
            "attrs": {"checked": True},
            "content": [{
                "type": "paragraph",
                "content": [
                    {"type": "text", "text": "bold", "marks": [{"type": "bold"}]},
                    {"type": "text", "text": " done"},
                ],
            }],
        }),
    )


def test_markdown_empty_task_item_is_an_empty_paragraph() -> None:
    assert normalized("- [ ]\n- [x] done") == doc(task_list(task(None), task("done", True)))


def test_markdown_mixed_list_stays_a_bullet_list() -> None:
    assert normalized("- [ ] todo\n- plain") == doc(bullets("[ ] todo", "plain"))


def test_markdown_ordered_task_syntax_stays_an_ordered_list() -> None:
    result = normalized("1. [ ] first\n2. [x] second")
    assert result["content"][0]["type"] == "orderedList"


def test_markdown_escaped_bracket_is_a_literal_item() -> None:
    assert normalized("- \\[ ] literal\n- \\[x] also literal") == doc(
        bullets("[ ] literal", "[x] also literal"),
    )


def test_markdown_bracket_without_a_space_is_not_a_task() -> None:
    assert normalized("- [x]y\n- [ ]z") == doc(bullets("[x]y", "[ ]z"))


# --- ProseMirror → markdown ---------------------------------------------------


def test_serialize_flat_checklist() -> None:
    assert prosemirror_to_markdown(doc(task_list(task("a"), task("b", True)))) == "- [ ] a\n- [x] b"


def test_serialize_nested_checklist_indents_by_the_bullet_width() -> None:
    tree = doc(task_list(task("parent", False, task_list(task("child", True))), task("next")))
    assert prosemirror_to_markdown(tree) == "- [ ] parent\n  - [x] child\n- [ ] next"


def test_serialize_empty_task_item_has_no_trailing_space() -> None:
    assert prosemirror_to_markdown(doc(task_list(task(None), task("x")))) == "- [ ]\n- [ ] x"


def test_serialize_checklist_under_a_bullet_item_is_tight() -> None:
    tree = doc({
        "type": "bulletList",
        "content": [{"type": "listItem", "content": [para("parent"), task_list(task("todo"))]}],
    })
    assert prosemirror_to_markdown(tree) == "- parent\n  - [ ] todo"


def test_serialize_treats_only_a_true_checked_as_done() -> None:
    tree = doc(task_list({"type": "taskItem", "content": [para("no attrs")]}))
    assert prosemirror_to_markdown(tree) == "- [ ] no attrs"


# --- round trips ----------------------------------------------------------------

ROUND_TRIP_DOCS = {
    "flat": doc(task_list(task("a"), task("b", True))),
    "nested-two-levels": doc(
        task_list(task("p", False, task_list(task("c", True, task_list(task("g")))))),
    ),
    "task-with-bullets": doc(task_list(task("p", False, bullets("x", "y")))),
    "bullets-with-tasks": doc({
        "type": "bulletList",
        "content": [{"type": "listItem", "content": [para("p"), task_list(task("t", True))]}],
    }),
    "between-paragraphs": doc(para("before"), task_list(task("t")), para("after")),
    "empty-item": doc(task_list(task(None), task("x", True))),
}


@pytest.mark.parametrize("name", list(ROUND_TRIP_DOCS))
def test_prosemirror_markdown_prosemirror_is_lossless(name: str) -> None:
    original = ROUND_TRIP_DOCS[name]
    assert normalized(prosemirror_to_markdown(original)) == original


@pytest.mark.parametrize(
    "markdown",
    [
        "- [ ] a\n- [x] b",
        "- [ ] parent\n  - [x] child\n    - [ ] grandchild\n- [ ] next",
        "## Plan\n\n- [x] spec\n- [ ] build\n\nNotes after.",
        "- [ ]\n- [x] *em* and `code`",
    ],
)
def test_markdown_is_a_fixed_point(markdown: str) -> None:
    assert prosemirror_to_markdown(normalize_note_content(markdown)) == markdown


# --- ProseMirror JSON input ------------------------------------------------------


def test_json_task_item_checked_is_coerced_to_a_strict_boolean() -> None:
    raw = doc(task_list(
        {"type": "taskItem", "attrs": {"checked": "false"}, "content": [para("string")]},
        {"type": "taskItem", "attrs": {"checked": 1}, "content": [para("int")]},
        {"type": "taskItem", "content": [para("missing")]},
        {"type": "taskItem", "attrs": {"checked": True}, "content": [para("real")]},
    ))
    items = normalized(raw)["content"][0]["content"]
    assert [item["attrs"]["checked"] for item in items] == [False, False, False, True]


def test_json_checklist_passes_through_unchanged() -> None:
    tree = doc(task_list(task("p", True, task_list(task("c")))))
    assert normalized(json.dumps(tree)) == tree


# --- HTML import -----------------------------------------------------------------


def test_html_tiptap_task_list_imports() -> None:
    html = (
        '<ul data-type="taskList">'
        '<li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked="checked">'
        "<span></span></label><div><p>done</p></div></li>"
        '<li data-type="taskItem" data-checked="false"><label><input type="checkbox"><span></span></label>'
        "<div><p>open</p></div></li>"
        "</ul>"
    )
    assert normalized(html) == doc(task_list(task("done", True), task("open")))


def test_html_checkbox_list_imports_as_task_list() -> None:
    html = (
        '<ul class="contains-task-list">'
        '<li class="task-list-item"><input type="checkbox" disabled checked> shipped</li>'
        '<li class="task-list-item"><input disabled="" type="checkbox"> pending</li>'
        "</ul>"
    )
    assert normalized(html) == doc(task_list(task("shipped", True), task("pending")))


def test_html_list_with_a_checkbox_in_only_some_items_stays_a_bullet_list() -> None:
    html = '<ul><li><input type="checkbox" checked> one</li><li>two</li></ul>'
    assert normalized(html) == doc(bullets("one", "two"))


def test_html_text_input_is_not_a_checkbox() -> None:
    html = '<ul><li><input type="text"> one</li></ul>'
    assert normalized(html) == doc(bullets("one"))


# --- unsafe media inside task items ------------------------------------------------


def _task_with(*children: dict) -> dict:
    return doc(task_list({"type": "taskItem", "attrs": {"checked": False}, "content": [para("t"), *children]}))


def test_unsafe_image_inside_a_task_item_is_stripped_from_json() -> None:
    raw = _task_with(
        {"type": "image", "attrs": {"src": "javascript:alert(1)", "alt": "x", "title": None}},
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "ok", "title": None}},
    )
    children = normalized(raw)["content"][0]["content"][0]["content"]
    assert [c["type"] for c in children] == ["paragraph", "image"]
    assert children[1]["attrs"]["src"] == STABLE_IMAGE


def test_unsafe_attachment_inside_a_nested_task_item_loses_its_link() -> None:
    attachment = {
        "type": "fileAttachment",
        "attrs": {"src": "data:text/html,<script>x</script>", "filename": "evil.html"},
    }
    raw = doc(task_list(task("p", False, task_list({
        "type": "taskItem", "attrs": {"checked": False}, "content": [para("c"), attachment],
    }))))
    stored = json.loads(strip_unsafe_media_text(json.dumps(raw)))
    nested = stored["content"][0]["content"][0]["content"][1]["content"][0]
    assert nested["content"][1]["attrs"] == {"src": None, "filename": "evil.html"}


def test_markdown_unsafe_image_inside_a_task_item_is_dropped() -> None:
    result = normalized("- [ ] see ![x](javascript:alert(1)) here\n- [ ] ![y](//evil.example/x.png)")
    items = result["content"][0]["content"]
    assert [item["type"] for item in items] == ["taskItem", "taskItem"]
    # markdown-it refuses the `javascript:` link outright, leaving inert text;
    # the protocol-relative src parses as an image and the media allowlist drops it.
    assert '"type": "image"' not in json.dumps(result)


def test_canonicaliser_rewrites_a_signed_image_inside_a_task_item() -> None:
    ctx = MediaLinkContext(workspace_id=WS, workspace_slug="acme", bucket=BUCKET)
    raw = json.dumps(_task_with({"type": "image", "attrs": {"src": SIGNED_IMAGE, "alt": "s", "title": None}}))
    canonical, report = canonicalize_rich_text(raw, ctx)
    assert report.rewritten == 1
    image = json.loads(canonical)["content"][0]["content"][0]["content"][1]
    assert image["attrs"]["src"] == STABLE_IMAGE
