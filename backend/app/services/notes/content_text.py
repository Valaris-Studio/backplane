# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Plain-text projection of a note's ProseMirror content.

Feeds two things that must agree with each other: the `notes.content_text`
column (what server-side search ILIKEs) and the list preview (what the user
reads before clicking). Both are the SAME text, so a note the operator can see
matched their query is a note whose preview shows why.

This is the backend twin of `frontend/src/lib/text-utils.ts::extractPlainText`
and deliberately mirrors its walk: text nodes joined by a single space, mention
atoms surfaced as `@Label` (they carry no text child, so searching a person's
name would otherwise never match), whitespace runs collapsed. Unlike the
frontend version this does NOT truncate — the column stores the full text so a
word past the preview cutoff is still findable. Truncation is `build_preview`.

Distinct from `content_serializer.prosemirror_to_markdown`, which reconstructs
markup for humans and round-trips; here markup is exactly what we're throwing
away.
"""
from __future__ import annotations

import json
import re
from typing import Any

PREVIEW_LENGTH = 200

_TAG_RE = re.compile(r"<[^>]*>")
_WHITESPACE_RE = re.compile(r"\s+")


def extract_plain_text(content: str | dict | None) -> str:
    """Return the searchable/previewable text for a stored note `content`.

    Non-PM inputs (legacy HTML or raw markdown stored before the normalizer
    landed) degrade to HTML-stripped text rather than raising — an unparseable
    body should still be searchable by whatever prose it holds.
    """
    if not content:
        return ""

    doc: dict[str, Any] | None = None
    if isinstance(content, dict):
        if content.get("type") == "doc":
            doc = content
    else:
        try:
            parsed = json.loads(content)
        except (json.JSONDecodeError, TypeError, ValueError):
            parsed = None
        if isinstance(parsed, dict) and parsed.get("type") == "doc":
            doc = parsed

    if doc is None:
        raw = content if isinstance(content, str) else ""
        return _collapse(_TAG_RE.sub(" ", raw))

    parts: list[str] = []
    _collect_text(doc, parts)
    return _collapse(" ".join(parts))


def build_preview(
    content: str | dict | None,
    content_text: str | None = None,
    limit: int = PREVIEW_LENGTH,
) -> str:
    """First `limit` characters of a note's plain text.

    Prefers the maintained `content_text` column — re-parsing the PM document
    per row is the cost this column exists to avoid. Falls back to extracting
    from `content` when it's NULL, which happens for rows written by old code
    during a rolling deploy (and before migration 099 backfills).
    """
    text = content_text if content_text is not None else extract_plain_text(content)
    return text[:limit]


def _collect_text(node: dict[str, Any], parts: list[str]) -> None:
    text = node.get("text")
    if text:
        parts.append(text)
    if node.get("type") == "mention":
        label = (node.get("attrs") or {}).get("label")
        if isinstance(label, str):
            parts.append(f"@{label}")
    for child in node.get("content") or []:
        if isinstance(child, dict):
            _collect_text(child, parts)


def _collapse(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text).strip()
