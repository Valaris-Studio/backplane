# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Plain-text excerpt of a card description, for the summary board payload.

The kanban board never renders the description BODY, but it does render a short
plain-text excerpt on each card face and matches the same text in its
client-side search filter. So `?summary=true` cannot simply drop the field: it
replaces the stored ProseMirror JSON (kilobytes per card) with the plain text
the board would otherwise have computed itself.

Search, not the card face, sets the length: the frontend ALWAYS fetches summary
mode, so anything trimmed here is permanently unsearchable, while the face
re-truncates to its own display width client-side (extractPlainText's 200-char
default in KanbanCard). Hence one field bounded at the search window.

Deliberately mirrors the frontend walker `frontend/src/lib/text-utils.ts`
(extractPlainText / stripHtmlTags) so a summary card and a full card render an
identical excerpt — the board must not visibly change when it switches modes.
Node text is joined with single spaces and whitespace collapsed, matching that
walker rather than the markdown serializer's block structure.
"""
from __future__ import annotations

import json
import re
from typing import Any

# Matches the window `use-board-filters` search reads (extractPlainText(desc,
# 5000)). Markup and the JSON envelope are already gone by this point, so this
# still sheds the bulk of a long body while keeping every searchable character.
EXCERPT_MAX_LENGTH = 5000

_ANY_TAG_RE = re.compile(r"<[^>]*>")
_WHITESPACE_RE = re.compile(r"\s+")


def card_description_excerpt(
    description: str | None, max_length: int = EXCERPT_MAX_LENGTH
) -> str:
    """Collapse a stored description to a bounded plain-text excerpt."""
    if not description:
        return ""

    try:
        parsed = json.loads(description)
    except (json.JSONDecodeError, ValueError):
        parsed = None

    if isinstance(parsed, dict) and parsed.get("type") == "doc":
        parts: list[str] = []
        _collect_text(parsed, parts)
        text = _WHITESPACE_RE.sub(" ", " ".join(parts)).strip()
    else:
        # Legacy HTML or plain text stored before the normalizer landed —
        # never let raw markup reach the board.
        text = _WHITESPACE_RE.sub(" ", _ANY_TAG_RE.sub(" ", description)).strip()

    return f"{text[:max_length]}..." if len(text) > max_length else text


def _collect_text(node: dict[str, Any], parts: list[str]) -> None:
    text = node.get("text")
    if isinstance(text, str) and text:
        parts.append(text)

    # A mention is an inline atom with no text child — surface its display
    # label as "@Label" so previews and client-side name search still match.
    if node.get("type") == "mention":
        label = (node.get("attrs") or {}).get("label")
        if isinstance(label, str):
            parts.append(f"@{label}")

    for child in node.get("content") or []:
        if isinstance(child, dict):
            _collect_text(child, parts)
