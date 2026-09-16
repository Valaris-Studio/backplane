# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Mention extraction — the ONE place TipTap text becomes a recipient set.

`extract_mention_ids` walks a ProseMirror doc (the storage format for both
`card.description` and `note.content`) and returns the set of mentioned user
ids. It is pure: no I/O, no DB, deterministic, unit-testable in isolation.

Contract (docs/mention-system-contract.md §2 + MEN-1, MEN-4):
  - Accepts the same shapes the note content_normalizer accepts:
    None / "" / dict / JSON string.
  - Collects every node with ``type == "mention"`` carrying a parseable
    ``attrs.id`` UUID; ignores ``attrs.label`` (id is identity).
  - Tolerates malformed input by returning ``set()`` — it NEVER raises, so a
    bad doc can never roll back the card/note write that triggered it.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

_MENTION_TYPE = "mention"


def extract_mention_ids(content: str | dict | None) -> set[uuid.UUID]:
    """Return the set of mentioned user ids in a PM-JSON doc. Never raises."""
    doc = _coerce_doc(content)
    if doc is None:
        return set()
    ids: set[uuid.UUID] = set()
    _collect(doc, ids)
    return ids


def _coerce_doc(content: str | dict | None) -> Any:
    """Coerce accepted input shapes into a walkable structure, or None."""
    if content is None or content == "":
        return None
    if isinstance(content, dict):
        return content
    if isinstance(content, str):
        try:
            return json.loads(content)
        except (ValueError, TypeError):
            return None
    # Any other type (int, list passed directly, …) is walked if it's a
    # container; a list is a valid PM `content` fragment.
    if isinstance(content, list):
        return content
    return None


def _collect(node: Any, ids: set[uuid.UUID]) -> None:
    """Recursively visit a PM node/fragment, harvesting mention ids."""
    if isinstance(node, list):
        for child in node:
            _collect(child, ids)
        return
    if not isinstance(node, dict):
        return
    if node.get("type") == _MENTION_TYPE:
        mention_id = _parse_id(node.get("attrs"))
        if mention_id is not None:
            ids.add(mention_id)
    children = node.get("content")
    if isinstance(children, list):
        _collect(children, ids)


def _parse_id(attrs: Any) -> uuid.UUID | None:
    if not isinstance(attrs, dict):
        return None
    raw = attrs.get("id")
    if raw is None:
        return None
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        return None
