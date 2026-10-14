# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Versioned digests that identify selected context independent of timestamps.

Both digests are domain-prefixed so a renderer or encoding change can never
collide with a content change of the previous version."""

import hashlib
import json
from typing import Any, Protocol

from app.schemas.agents.context import ContextManifest

MANIFEST_SCHEMA_VERSION = 1
BUDGETED_MANIFEST_SCHEMA_VERSION = 2
RENDERER_VERSION = "context-v1"

_NOTE_REVISION_DOMAIN = "backplane.note-revision.v1\0"
_CONTEXT_REVISION_DOMAIN = "backplane.context-revision.v1\0"


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8"))


def canonical_json(value: Any) -> str:
    # No Unicode normalization: escaped and literal forms of one document
    # compare equal only because json.loads already decoded them.
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _revision_content(stored: str) -> Any:
    # Only a ProseMirror document is canonicalized; plain text, HTML, malformed
    # JSON and non-document JSON keep their exact stored string, so two legacy
    # bodies that render identically still have distinct revisions.
    try:
        parsed = json.loads(stored)
    except (ValueError, TypeError):
        return stored
    if isinstance(parsed, dict) and parsed.get("type") == "doc":
        return parsed
    return stored


class RevisionedNote(Protocol):
    @property
    def title(self) -> str: ...
    @property
    def content(self) -> str: ...
    @property
    def kind(self) -> str: ...
    @property
    def pinned(self) -> bool: ...


def note_revision(note: RevisionedNote) -> str:
    payload = {
        "title": note.title,
        "content": _revision_content(note.content),
        "kind": note.kind,
        "pinned": note.pinned,
    }
    return sha256_text(_NOTE_REVISION_DOMAIN + canonical_json(payload))


def context_revision(manifest: ContextManifest) -> str:
    """Digest of the whole manifest except observed record timestamps: config
    order, alias, filter, coverage, rendered hashes and selected record set."""
    document = manifest.model_dump(mode="json")
    for source in document["sources"]:
        for record in source["records"]:
            record.pop("updated_at", None)
    return sha256_text(_CONTEXT_REVISION_DOMAIN + canonical_json(document))
