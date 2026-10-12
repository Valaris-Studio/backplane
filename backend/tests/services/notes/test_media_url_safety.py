# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Image and attachment `src` must never carry an executable scheme.

The attachment view opens `src` with `window.open` for every viewer, so a
`javascript:` src stored in a note is a stored XSS. Every input shape —
markdown, HTML and ProseMirror JSON (MCP `update_note` can send it directly) —
goes through the same allowlist: a root-relative path or an http(s) URL.
"""
from __future__ import annotations

import json

import pytest

from app.services.notes.content_normalizer import normalize_note_content
from app.services.notes.media_markdown import is_safe_media_url

STABLE = "/api/workspaces/acme/resources/44444444-4444-4444-8444-444444444444/content"

UNSAFE_URLS = [
    pytest.param("javascript:alert(1)", id="javascript"),
    pytest.param("JavaScript:alert(1)", id="javascript-mixed-case"),
    pytest.param(" javascript:alert(1)", id="leading-space"),
    pytest.param("\tjavascript:alert(1)", id="leading-tab"),
    pytest.param("java\tscript:alert(1)", id="tab-inside-scheme"),
    pytest.param("java\nscript:alert(1)", id="newline-inside-scheme"),
    pytest.param("\x00javascript:alert(1)", id="leading-nul"),
    pytest.param("java&#x73;cript:alert(1)", id="entity-in-scheme-literal"),
    pytest.param("vbscript:msgbox(1)", id="vbscript"),
    pytest.param("data:text/html,<script>alert(1)</script>", id="data-html"),
    pytest.param("data:image/svg+xml;base64,PHN2Zz4=", id="data-image"),
    pytest.param("file:///etc/passwd", id="file"),
    pytest.param("//evil.example/x.png", id="protocol-relative"),
    pytest.param("/\\evil.example/x.png", id="slash-backslash"),
    pytest.param("/\t/evil.example/x.png", id="slash-tab-slash"),
    pytest.param("\\\\evil.example\\x.png", id="backslashes"),
    pytest.param("https:evil.example", id="https-without-slashes"),
    pytest.param("blob:https://app/1", id="blob"),
    pytest.param("shot.png", id="bare-relative"),
    pytest.param("", id="empty"),
]

SAFE_URLS = [
    pytest.param(STABLE, id="stable-resource"),
    pytest.param("/api/workspaces/acme/media/33333333-3333-4333-8333-333333333333/a%20b.png", id="stable-media"),
    pytest.param("https://example.com/cat.png", id="https"),
    pytest.param("HTTP://example.com/cat.png", id="http-upper"),
    pytest.param(
        "https://storage.googleapis.com/b/k.png?X-Goog-Signature=abc&X-Goog-Expires=3600",
        id="legacy-signed",
    ),
]


@pytest.mark.parametrize("url", UNSAFE_URLS)
def test_unsafe_media_url_is_refused(url: str) -> None:
    assert is_safe_media_url(url) is False


@pytest.mark.parametrize("url", SAFE_URLS)
def test_safe_media_url_is_accepted(url: str) -> None:
    assert is_safe_media_url(url) is True


def _nodes(content: str | dict) -> list[dict]:
    return json.loads(normalize_note_content(content))["content"]


def _html_attr(url: str) -> str:
    return url.replace("&", "&amp;").replace('"', "&quot;")


@pytest.mark.parametrize("url", UNSAFE_URLS)
def test_html_attachment_with_unsafe_href_keeps_no_link(url: str) -> None:
    nodes = _nodes(f'<p><a href="{_html_attr(url)}" title="attachment; size=1">Click</a></p>')
    attachments = [node for node in nodes if node["type"] == "fileAttachment"]
    assert all(node["attrs"]["src"] is None for node in attachments)


@pytest.mark.parametrize("url", UNSAFE_URLS)
def test_html_img_with_unsafe_src_is_dropped(url: str) -> None:
    nodes = _nodes(f'<p>a <img src="{_html_attr(url)}" alt="x"> b</p>')
    assert [node["type"] for node in nodes if node["type"] == "image"] == []


@pytest.mark.parametrize(
    "html",
    [
        pytest.param('<p><a href="java&#x73;cript:alert(1)" title="attachment">x</a></p>', id="hex-entity"),
        pytest.param('<p><a href="java&#115;cript:alert(1)" title="attachment">x</a></p>', id="decimal-entity"),
        pytest.param('<p><a href="&#x20;javascript:alert(1)" title="attachment">x</a></p>', id="entity-space"),
        pytest.param('<p><a href="java&Tab;script:alert(1)" title="attachment">x</a></p>', id="entity-tab"),
        pytest.param("<p><a href='javascript:alert(1)' title='attachment'>x</a></p>", id="single-quoted"),
        pytest.param('<p><a href=javascript:alert(1) title="attachment">x</a></p>', id="unquoted"),
    ],
)
def test_html_entity_obfuscated_attachment_scheme_is_neutralised(html: str) -> None:
    (node,) = _nodes(html)
    assert node["type"] == "fileAttachment"
    assert node["attrs"]["src"] is None


def test_html_entity_obfuscated_img_scheme_is_dropped() -> None:
    nodes = _nodes('<img src="java&#x73;cript:alert(1)" alt="x">')
    assert all(node["type"] != "image" for node in nodes)


@pytest.mark.parametrize(
    "markdown",
    [
        pytest.param('[x](javascript:alert(1) "attachment")', id="javascript"),
        pytest.param('[x](<java\tscript:alert(1)> "attachment")', id="tab-in-angle-destination"),
        pytest.param('[x](//evil.example/x "attachment")', id="protocol-relative"),
        pytest.param('[x](data:text/html,hi "attachment")', id="data"),
    ],
)
def test_markdown_attachment_with_unsafe_src_carries_no_link(markdown: str) -> None:
    for node in _nodes(markdown):
        if node["type"] == "fileAttachment":
            assert node["attrs"]["src"] is None


@pytest.mark.parametrize(
    "markdown",
    [
        pytest.param("![x](javascript:alert(1))", id="javascript"),
        pytest.param("![x](data:image/png;base64,AAAA)", id="data-image"),
        pytest.param("![x](//evil.example/x.png)", id="protocol-relative"),
    ],
)
def test_markdown_image_with_unsafe_src_is_dropped(markdown: str) -> None:
    assert all(node["type"] != "image" for node in _nodes(markdown))


@pytest.mark.parametrize("url", UNSAFE_URLS)
def test_prosemirror_json_attachment_with_unsafe_src_is_neutralised(url: str) -> None:
    doc = {
        "type": "doc",
        "content": [
            {"type": "fileAttachment", "attrs": {"src": url, "filename": "x.pdf", "fileSize": 1}},
        ],
    }
    for content in (doc, json.dumps(doc)):
        (node,) = _nodes(content)
        assert node["attrs"] == {"src": None, "filename": "x.pdf", "fileSize": 1}


@pytest.mark.parametrize("url", UNSAFE_URLS)
def test_prosemirror_json_image_with_unsafe_src_is_dropped_at_any_depth(url: str) -> None:
    doc = {
        "type": "doc",
        "content": [
            {"type": "image", "attrs": {"src": url, "alt": "top"}},
            {
                "type": "bulletList",
                "content": [{"type": "listItem", "content": [{"type": "image", "attrs": {"src": url}}]}],
            },
        ],
    }
    nodes = _nodes(doc)
    assert "image" not in json.dumps(nodes)


def test_prosemirror_json_with_safe_media_is_unchanged() -> None:
    doc = {
        "type": "doc",
        "content": [
            {"type": "image", "attrs": {"src": STABLE, "alt": "a"}},
            {"type": "fileAttachment", "attrs": {"src": "https://f.example/s.pdf", "filename": "s.pdf"}},
            {"type": "image", "attrs": {"src": None, "alt": "placeholder"}},
        ],
    }
    assert json.loads(normalize_note_content(doc)) == doc
