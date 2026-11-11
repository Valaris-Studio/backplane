# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from collections import Counter
from dataclasses import dataclass, field
from typing import Any

from app.services.agents.context_manifest import canonical_json, sha256_text, utf8_bytes
from app.services.notes.content_serializer import prosemirror_to_markdown
from app.services.notes.media_markdown import escape_label


def note_class(note) -> tuple[str, str]:
    principal = note.author_principal_kind
    author = f"{principal} {note.created_by}" if principal else "unknown author"
    promoted = note.pinned and (note.pinned_by is not None or principal is None)
    if promoted:
        return "directive", f"instruction; {author}"
    if principal == "agent":
        return "agent_working_note", f"agent working note, not instruction; agent {note.author_agent_id}"
    return "shared_record", f"content; {author}"


def quote_data(text: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return "\n".join(f"> {line}" for line in normalized.split("\n"))


def snapshot_record(source_kind, entity_type, entity_id, material_class, label, text, **attribution):
    return {
        "source_kind": source_kind,
        "entity_type": entity_type,
        "entity_id": str(entity_id),
        "class": material_class,
        "label": label,
        "text": text,
        "sha256": sha256_text(text),
        **attribution,
    }


def snapshot_note(source_kind, note, legacy_text):
    material_class, label = note_class(note)
    body = prosemirror_to_markdown(note.content)
    if material_class == "agent_working_note":
        text = quote_data(f"{escape_label(note.title)}\n\n{body}")
    else:
        text = legacy_text
    return snapshot_record(
        source_kind, "note", note.id, material_class, label,
        f"{label}\n\n{text}",
        created_by=str(note.created_by) if note.created_by else None,
        author_principal_kind=note.author_principal_kind,
        author_agent_id=str(note.author_agent_id) if note.author_agent_id else None,
        pinned_by=str(note.pinned_by) if note.pinned_by else None,
    )


@dataclass
class SnapshotSelection:
    blocks: list[dict[str, Any]] = field(default_factory=list)
    omissions: list[dict[str, Any]] = field(default_factory=list)
    seen_notes: set = field(default_factory=set)
    observed_sources: set[str] = field(default_factory=set)

    def omit(self, source_kind, reason, *, record=None, entity_type=None, entity_id=None, **details):
        entry = {"source_kind": source_kind, "reason": reason, **details}
        if record is not None:
            entry.update({key: record[key] for key in ("entity_type", "entity_id", "sha256")})
        elif entity_id is not None:
            entry.update(entity_type=entity_type, entity_id=str(entity_id))
        self.omissions.append(entry)

    def bounded_omissions(self, ceilings):
        reason_counts = dict(Counter(entry["reason"] for entry in self.omissions))
        identities = {
            (entry["entity_type"], entry["entity_id"])
            for entry in self.omissions if "entity_id" in entry
        }
        kept = self.omissions[:ceilings.max_diagnostic_entries]
        while True:
            retained_identities = {
                (entry["entity_type"], entry["entity_id"])
                for entry in kept if "entity_id" in entry
            }
            identities_omitted = len(identities - retained_identities)
            summary = {
                "total_count": len(self.omissions),
                "reason_counts": reason_counts,
                "identities_omitted": identities_omitted,
                "identity_coverage": "partial" if identities_omitted else "complete",
            }
            envelope = {"omissions": kept, "omissions_summary": summary}
            if utf8_bytes(canonical_json(envelope)) <= ceilings.max_diagnostic_bytes:
                return kept, summary
            # The fixed summary fits the minimum ceiling even without entries.
            kept = kept[:-1]

    def identity(self, block):
        return {key: value for key, value in block.items() if key != "text"}
