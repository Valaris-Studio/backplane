# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The markdown spelling of note images and attachments — one place, both directions.

    ![alt](src "title")
    [filename](src "attachment; size=<bytes>; type=<mime>")

An attachment is a link whose title is `attachment`, optionally followed by
`;`-separated `size=` and `type=` params (in any order, each optional). Only a
link that is the WHOLE paragraph becomes an attachment; the same link inside
running text, or with any other title, stays an ordinary link. The serializer
writes this form and the normalizer reads it, so `get_note(format="markdown")`
→ edit → `update_note` keeps every image and attachment.
"""
from __future__ import annotations

import json
import re
from typing import Any

ATTACHMENT_TITLE_KEYWORD = "attachment"
DEFAULT_ATTACHMENT_MIME = "application/octet-stream"

_MIME_RE = re.compile(r"^[\w.+-]+/[\w.+-]+$")
_SIZE_RE = re.compile(r"^\d+$")
# Characters that would otherwise start markdown syntax inside a link label.
_LABEL_SPECIALS_RE = re.compile(r"([\\\[\]*_`~<])")
# `&name;` / `&#123;` would be decoded as an HTML entity on re-parse.
_ENTITY_LIKE_RE = re.compile(r"&(?=#?[A-Za-z0-9]+;)")
_NEEDS_ANGLE_DESTINATION_RE = re.compile(r"[\s()<>]")


def escape_label(text: str) -> str:
    return _ENTITY_LIKE_RE.sub(r"\\&", _LABEL_SPECIALS_RE.sub(r"\\\1", text))


def link_destination(src: str) -> str:
    if not src:
        return "<>"
    if _NEEDS_ANGLE_DESTINATION_RE.search(src):
        return "<" + src.replace("<", "\\<").replace(">", "\\>") + ">"
    return src


def link_title(title: str) -> str:
    return '"' + title.replace("\\", "\\\\").replace('"', '\\"') + '"'


def image_markdown(attrs: dict[str, Any]) -> str:
    title = attrs.get("title")
    title_part = f" {link_title(title)}" if title else ""
    return f"![{escape_label(attrs.get('alt') or '')}]({link_destination(attrs.get('src') or '')}{title_part})"


def attachment_title(file_size: Any, mime_type: Any) -> str:
    params = [ATTACHMENT_TITLE_KEYWORD]
    if isinstance(file_size, int) and not isinstance(file_size, bool) and file_size > 0:
        params.append(f"size={file_size}")
    if isinstance(mime_type, str) and mime_type != DEFAULT_ATTACHMENT_MIME and _MIME_RE.match(mime_type):
        params.append(f"type={mime_type}")
    return "; ".join(params)


def attachment_markdown(attrs: dict[str, Any]) -> str:
    name = attrs.get("filename") or "attachment"
    src = attrs.get("src") or ""
    if not src:
        # An upload that never resolved has nothing to link to.
        return name
    title = attachment_title(attrs.get("fileSize"), attrs.get("mimeType"))
    return f"[{escape_label(name)}]({link_destination(src)} {link_title(title)})"


def parse_attachment_title(title: str | None) -> dict[str, Any] | None:
    """`{"fileSize", "mimeType"}` when `title` is the attachment form, else None."""
    if not title:
        return None
    keyword, *params = [part.strip() for part in title.split(";")]
    if keyword.casefold() != ATTACHMENT_TITLE_KEYWORD:
        return None
    attrs: dict[str, Any] = {"fileSize": 0, "mimeType": DEFAULT_ATTACHMENT_MIME}
    for param in params:
        key, _, value = param.partition("=")
        key, value = key.strip().casefold(), value.strip()
        if key == "size" and _SIZE_RE.match(value):
            attrs["fileSize"] = int(value)
        elif key == "type" and _MIME_RE.match(value):
            attrs["mimeType"] = value
    return attrs


_HTTP_URL_RE = re.compile(r"^https?://[^/\\]", re.IGNORECASE)
# The WHATWG URL parser trims leading/trailing C0 controls and spaces and
# deletes every tab/CR/LF anywhere — `java\tscript:` and `/\t/evil` become
# `javascript:` and `//evil`. Mirror that before checking the prefix.
_EDGE_CONTROL_OR_SPACE_RE = re.compile(r"^[\x00-\x20]|[\x00-\x20]$")
_TAB_OR_NEWLINE_RE = re.compile(r"[\t\n\r]")


def is_safe_media_url(url: object) -> bool:
    """Allowlist for an image/attachment `src`: a root-relative app path or an
    http(s) URL. The attachment view `window.open`s this value for every
    viewer, so anything else — `javascript:`, `data:`, `file:`, `blob:`,
    protocol-relative `//host`, backslash tricks — is refused."""
    if not isinstance(url, str) or not url or _EDGE_CONTROL_OR_SPACE_RE.search(url):
        return False
    parsed_as = _TAB_OR_NEWLINE_RE.sub("", url)
    if parsed_as.startswith("/"):
        return not parsed_as.startswith(("//", "/\\"))
    return _HTTP_URL_RE.match(parsed_as) is not None


def attachment_node(src: str, filename: str, title_attrs: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "fileAttachment",
        "attrs": {"src": src if is_safe_media_url(src) else None, "filename": filename, **title_attrs},
    }


def image_node(src: str, alt: str | None, title: str | None) -> dict[str, Any] | None:
    """None when `src` is unsafe: an image with no usable source is dropped."""
    if not is_safe_media_url(src):
        return None
    return {"type": "image", "attrs": {"src": src, "alt": alt or None, "title": title or None}}


def strip_unsafe_media(node: Any) -> Any:
    """Apply the same allowlist to a ProseMirror tree in place: unsafe images
    are removed, unsafe attachments keep their name but lose the link. A
    missing/null src (an upload placeholder) is not a URL and is left alone."""
    if isinstance(node, dict):
        content = node.get("content")
        if isinstance(content, list):
            node["content"] = [child for child in content if not _is_unsafe_image(child)]
            for child in node["content"]:
                strip_unsafe_media(child)
        attrs = node.get("attrs")
        if node.get("type") == "fileAttachment" and isinstance(attrs, dict) and _has_unsafe_src(attrs):
            attrs["src"] = None
    return node


def strip_unsafe_media_text(value: Any) -> Any:
    """`strip_unsafe_media` for a stored rich-text string. Only a ProseMirror
    JSON doc is touched, and only re-serialised when something was removed, so
    clean rows stay byte-identical."""
    if not isinstance(value, str) or not value.lstrip().startswith("{"):
        return value
    try:
        doc = json.loads(value)
    except ValueError:
        return value
    if not isinstance(doc, dict) or doc.get("type") != "doc":
        return value
    before = json.dumps(doc)
    after = json.dumps(strip_unsafe_media(doc))
    return value if after == before else after


def _has_unsafe_src(attrs: dict[str, Any]) -> bool:
    src = attrs.get("src")
    return src is not None and not is_safe_media_url(src)


def _is_unsafe_image(node: Any) -> bool:
    return (
        isinstance(node, dict)
        and node.get("type") == "image"
        and isinstance(node.get("attrs"), dict)
        and _has_unsafe_src(node["attrs"])
    )
