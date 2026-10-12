# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Images and attachments survive ProseMirror → markdown → ProseMirror.

An agent reads a note as markdown, edits it and writes it back. Before this
contract the normalizer dropped every `![alt](src)` and the serializer wrote an
attachment as a bare link, so that edit silently deleted a human's images and
degraded their attachments. The markdown forms pinned here are the contract:

    ![alt](src "title")
    [filename](src "attachment; size=<bytes>; type=<mime>")
"""
from __future__ import annotations

import json
import uuid
from typing import Any

import pytest

from app.services.media.links import MediaLinkContext, canonicalize_rich_text
from app.services.notes.content_normalizer import normalize_note_content
from app.services.notes.content_serializer import prosemirror_to_markdown

WS = uuid.UUID("11111111-1111-4111-8111-111111111111")
OBJ = uuid.UUID("33333333-3333-4333-8333-333333333333")
RESOURCE_ID = uuid.UUID("44444444-4444-4444-8444-444444444444")
BUCKET = "valaris-media"
STABLE_IMAGE = f"/api/workspaces/acme/media/{OBJ}/screen%20shot.png"
STABLE_RESOURCE = f"/api/workspaces/acme/resources/{RESOURCE_ID}/content"
SIGNED_IMAGE = (
    f"https://storage.googleapis.com/{BUCKET}/media/{WS}/{OBJ}/screen%20shot.png"
    "?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Credential=x%2F20261005"
    "&X-Goog-Expires=3600&X-Goog-Signature=abc123"
)


def doc(*nodes: dict) -> dict:
    return {"type": "doc", "content": list(nodes)}


def image(src: str, alt: str | None = None, title: str | None = None) -> dict:
    return {"type": "image", "attrs": {"src": src, "alt": alt, "title": title}}


def attachment(src: str, filename: str, size: int = 0, mime: str = "application/octet-stream") -> dict:
    return {
        "type": "fileAttachment",
        "attrs": {
            "src": src,
            "filename": filename,
            "fileSize": size,
            "mimeType": mime,
            "uploading": False,
        },
    }


def paragraph(text: str, marks: list[dict] | None = None) -> dict:
    run: dict[str, Any] = {"type": "text", "text": text}
    if marks:
        run["marks"] = marks
    return {"type": "paragraph", "content": [run]}


def _meaningful(node: Any) -> Any:
    """Drop attrs that carry no information: unset (None) values and the
    editor-only `uploading` flag, which is never true in a saved note."""
    if isinstance(node, list):
        return [_meaningful(child) for child in node]
    if not isinstance(node, dict):
        return node
    out = {}
    for key, value in node.items():
        if key == "attrs" and isinstance(value, dict):
            out[key] = {k: v for k, v in value.items() if v is not None and k != "uploading"}
        else:
            out[key] = _meaningful(value)
    return out


def round_trip(pm: dict) -> dict:
    return json.loads(normalize_note_content(prosemirror_to_markdown(pm)))


def assert_round_trips(pm: dict) -> None:
    assert _meaningful(round_trip(pm)) == _meaningful(pm)


# --- Images -----------------------------------------------------------------


def test_image_with_alt_and_title_serializes_to_titled_image_markdown() -> None:
    pm = doc(image(STABLE_IMAGE, alt="Login screen", title="Step 1"))
    assert prosemirror_to_markdown(pm) == f'![Login screen]({STABLE_IMAGE} "Step 1")'


@pytest.mark.parametrize(
    "node",
    [
        pytest.param(image(STABLE_IMAGE, alt="Login screen", title="Step 1"), id="alt-and-title"),
        pytest.param(image(STABLE_IMAGE, alt="Login screen"), id="alt-only"),
        pytest.param(image(STABLE_IMAGE), id="bare"),
        pytest.param(image(STABLE_IMAGE, alt="a [bracketed] *starred* alt"), id="alt-with-markdown-specials"),
        pytest.param(image(STABLE_IMAGE, alt="x", title='say "cheese"'), id="title-with-quotes"),
        pytest.param(image("https://example.com/cat.png", alt="cat"), id="external-image"),
        pytest.param(
            image("https://en.example.org/wiki/File:Cat_(1).png", alt="cat"),
            id="external-image-with-parens",
        ),
        pytest.param(image(SIGNED_IMAGE, alt="legacy"), id="legacy-signed-url-kept-byte-exact"),
    ],
)
def test_image_survives_round_trip(node: dict) -> None:
    assert_round_trips(doc(node))


def test_image_inside_running_text_becomes_its_own_block() -> None:
    """Our schema's image is a BLOCK node, so an inline `![]()` splits its
    paragraph instead of being dropped."""
    parsed = json.loads(normalize_note_content(f"Before ![shot]({STABLE_IMAGE}) after"))
    assert parsed["content"] == [
        paragraph("Before"),
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "shot", "title": None}},
        paragraph("after"),
    ]


def test_image_in_a_list_item_survives_round_trip() -> None:
    pm = doc({
        "type": "bulletList",
        "content": [
            {"type": "listItem", "content": [paragraph("step"), image(STABLE_IMAGE, alt="s")]},
        ],
    })
    assert_round_trips(pm)


# --- Attachments ------------------------------------------------------------


def test_attachment_serializes_to_attachment_titled_link() -> None:
    pm = doc(attachment(STABLE_RESOURCE, "spec sheet.pdf", size=48213, mime="application/pdf"))
    assert prosemirror_to_markdown(pm) == (
        f'[spec sheet.pdf]({STABLE_RESOURCE} "attachment; size=48213; type=application/pdf")'
    )


def test_attachment_without_metadata_serializes_to_bare_attachment_title() -> None:
    pm = doc(attachment(STABLE_RESOURCE, "notes.txt"))
    assert prosemirror_to_markdown(pm) == f'[notes.txt]({STABLE_RESOURCE} "attachment")'


@pytest.mark.parametrize(
    "node",
    [
        pytest.param(
            attachment(STABLE_RESOURCE, "spec sheet.pdf", size=48213, mime="application/pdf"),
            id="name-size-and-type",
        ),
        pytest.param(attachment(STABLE_RESOURCE, "notes.txt"), id="name-only"),
        pytest.param(attachment(STABLE_RESOURCE, "big.zip", size=10_485_760), id="size-only"),
        pytest.param(
            attachment(STABLE_RESOURCE, "deck.pptx",
                       mime="application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            id="long-vendor-mime",
        ),
        pytest.param(attachment(STABLE_RESOURCE, "notes_[v2]*final*.md"), id="filename-with-markdown-specials"),
        pytest.param(attachment(STABLE_RESOURCE, "R&amp;D.txt"), id="filename-that-looks-like-an-entity"),
    ],
)
def test_attachment_survives_round_trip(node: dict) -> None:
    assert_round_trips(doc(node))


def test_attachment_metadata_params_parse_in_any_order() -> None:
    markdown = f'[a.pdf]({STABLE_RESOURCE} "attachment; type=application/pdf; size=7")'
    parsed = json.loads(normalize_note_content(markdown))
    assert parsed["content"] == [{
        "type": "fileAttachment",
        "attrs": {"src": STABLE_RESOURCE, "filename": "a.pdf", "fileSize": 7, "mimeType": "application/pdf"},
    }]


@pytest.mark.parametrize(
    "markdown",
    [
        pytest.param(f'See [spec.pdf]({STABLE_RESOURCE} "attachment") for details', id="inside-running-text"),
        pytest.param(f'[spec.pdf]({STABLE_RESOURCE} "the spec")', id="ordinary-title"),
        pytest.param(f"[spec.pdf]({STABLE_RESOURCE})", id="untitled"),
    ],
)
def test_ordinary_links_stay_links(markdown: str) -> None:
    parsed = json.loads(normalize_note_content(markdown))
    assert [node["type"] for node in parsed["content"]] == ["paragraph"]
    linked = [run for run in parsed["content"][0]["content"] if run.get("marks")]
    assert linked[0]["marks"] == [{"type": "link", "attrs": {"href": STABLE_RESOURCE}}]


# --- Mixed documents --------------------------------------------------------

MIXED = doc(
    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Release notes"}]},
    paragraph("Shipped"),
    image(STABLE_IMAGE, alt="New dashboard", title="Dashboard"),
    {
        "type": "bulletList",
        "content": [
            {"type": "listItem", "content": [paragraph("fast", [{"type": "bold"}])]},
            {"type": "listItem", "content": [paragraph("small")]},
        ],
    },
    attachment(STABLE_RESOURCE, "changelog.md", size=912, mime="text/markdown"),
    image("https://example.com/badge.svg", alt="badge"),
    # markdown-it's fence content always ends in one newline.
    {"type": "codeBlock", "attrs": {"language": "bash"}, "content": [{"type": "text", "text": "make deploy\n"}]},
)


def test_mixed_document_survives_round_trip() -> None:
    assert_round_trips(MIXED)


def test_mixed_document_markdown_is_a_fixed_point() -> None:
    markdown = prosemirror_to_markdown(MIXED)
    assert prosemirror_to_markdown(normalize_note_content(markdown)) == markdown


# --- Save-time canonicalisation still applies -------------------------------


def test_markdown_signed_image_url_is_canonicalised_after_normalisation() -> None:
    """The save path normalizes first and canonicalises the PM result, so a
    signed URL written as markdown is stored as the stable relative path."""
    ctx = MediaLinkContext(workspace_id=WS, workspace_slug="acme", bucket=BUCKET)
    normalized = normalize_note_content(f'![shot]({SIGNED_IMAGE} "Login")')
    canonical, report = canonicalize_rich_text(normalized, ctx)
    assert report.rewritten == 1
    assert json.loads(canonical)["content"] == [
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "shot", "title": "Login"}},
    ]


# --- HTML input -------------------------------------------------------------


def test_html_img_tag_becomes_an_image_node() -> None:
    parsed = json.loads(normalize_note_content(
        f'<p>Intro</p><p><img src="{STABLE_IMAGE}" alt="shot" title="Login"></p>'
    ))
    assert parsed["content"] == [
        paragraph("Intro"),
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "shot", "title": "Login"}},
    ]


def test_bare_html_img_tag_is_parsed_as_html() -> None:
    parsed = json.loads(normalize_note_content(f'<img src="{STABLE_IMAGE}" alt="shot">'))
    assert parsed["content"] == [
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "shot", "title": None}},
    ]


def test_markdown_mentioning_an_img_tag_stays_markdown() -> None:
    parsed = json.loads(normalize_note_content('# Tips\n\n- write `<img src="x.png">` sparingly'))
    assert [node["type"] for node in parsed["content"]] == ["heading", "bulletList"]


def test_html_attachment_titled_anchor_becomes_an_attachment() -> None:
    parsed = json.loads(normalize_note_content(
        f'<p><a href="{STABLE_RESOURCE}" title="attachment; size=10; type=text/plain">a &amp; b.txt</a></p>'
    ))
    assert parsed["content"] == [{
        "type": "fileAttachment",
        "attrs": {"src": STABLE_RESOURCE, "filename": "a & b.txt", "fileSize": 10, "mimeType": "text/plain"},
    }]


def test_html_image_inside_running_text_splits_the_paragraph() -> None:
    parsed = json.loads(normalize_note_content(f'<p>Before <img src="{STABLE_IMAGE}"> after</p>'))
    assert parsed["content"] == [
        paragraph("Before"),
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": None, "title": None}},
        paragraph("after"),
    ]
