# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Media/link URL allowlist for the approval fields the decide dialog renders.

`action_description`, `decision_reason` and `action_payload.details` go
through the frontend RichTextRenderer, which accepts ProseMirror JSON, HTML
and markdown. Approvals keep the string the agent wrote (MCP and runner
readers get it back as-is), so instead of normalising to ProseMirror like
notes, a ProseMirror doc is stripped in place and markdown/HTML has only its
unsafe URL targets rewritten. Clean values come back byte-identical.
"""
from __future__ import annotations

import copy
import json
from typing import Any

from app.services.media.unsafe_markup import neutralise_unsafe_markup_urls
from app.services.notes.media_markdown import strip_unsafe_media, strip_unsafe_media_text

RENDERED_PAYLOAD_KEY = "details"


def sanitise_rich_text(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = strip_unsafe_media_text(value)
    if _is_prosemirror_doc(stripped):
        return stripped
    return neutralise_unsafe_markup_urls(stripped)


def sanitise_action_payload(payload: Any) -> Any:
    """Agents choose the payload keys, so every ProseMirror doc in it (a dict
    or a JSON string, at any depth) is stripped; `details`, the one key the
    dialog renders, also gets the markdown/HTML scrub."""
    sanitised = _strip_docs(payload)
    if isinstance(sanitised, dict) and isinstance(sanitised.get(RENDERED_PAYLOAD_KEY), str):
        sanitised[RENDERED_PAYLOAD_KEY] = sanitise_rich_text(sanitised[RENDERED_PAYLOAD_KEY])
    return sanitised


def _strip_docs(value: Any) -> Any:
    if isinstance(value, dict):
        if value.get("type") == "doc":
            return strip_unsafe_media(copy.deepcopy(value))
        return {key: _strip_docs(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_strip_docs(item) for item in value]
    if isinstance(value, str):
        return strip_unsafe_media_text(value)
    return value


def _is_prosemirror_doc(value: str) -> bool:
    if not value.lstrip().startswith("{"):
        return False
    try:
        parsed = json.loads(value)
    except ValueError:
        return False
    return isinstance(parsed, dict) and parsed.get("type") == "doc"
