# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import copy
import hashlib
import json
import uuid
from collections.abc import Iterator
from typing import TypedDict

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.notes.history import NoteRevision
from app.models.notes.note import Note
from app.repositories.notes.history import NoteHistoryRepository

STORAGE_VERSION = 1
MIN_CHUNK_BYTES = 2048
TARGET_CHUNK_BYTES = 8192
MAX_CHUNK_BYTES = 16384
GEAR_MASK = TARGET_CHUNK_BYTES - 1
GEAR_WINDOW_BYTES = GEAR_MASK.bit_length()
GEAR_VALUES = tuple(
    int.from_bytes(hashlib.sha256(b"backplane-note-gear-v1\0" + bytes([value])).digest()[:8])
    for value in range(256)
)
STATE_DIGEST_DOMAIN = b"backplane-note-state-v1\0"
SNAPSHOT_FIELDS = (
    "content", "title", "pinned", "card_id", "kind", "failure_class", "findings",
    "source_execution_id",
)


class NoteSnapshot(TypedDict):
    content: str
    title: str
    pinned: bool
    card_id: str | None
    kind: str
    failure_class: str | None
    findings: list | None
    source_execution_id: str | None


def snapshot(note: Note) -> NoteSnapshot:
    return {
        "content": note.content,
        "title": note.title,
        "pinned": note.pinned,
        "card_id": str(note.card_id) if note.card_id is not None else None,
        "kind": note.kind,
        "failure_class": note.failure_class,
        "findings": copy.deepcopy(note.findings),
        "source_execution_id": (
            str(note.source_execution_id) if note.source_execution_id is not None else None
        ),
    }


def revision_digest(value: NoteSnapshot) -> str:
    encoded = json.dumps(
        {field: value[field] for field in SNAPSHOT_FIELDS},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(STATE_DIGEST_DOMAIN + encoded).hexdigest()


def content_chunks(content: bytes) -> Iterator[bytes]:
    start = 0
    while start < len(content):
        minimum = min(start + MIN_CHUNK_BYTES, len(content))
        maximum = min(start + MAX_CHUNK_BYTES, len(content))
        # Only the low 13 bits decide a boundary. Earlier gear contributions
        # have shifted out by the first eligible position, so skip that prefix.
        position = max(start, minimum - GEAR_WINDOW_BYTES)
        gear = 0
        while position < maximum:
            gear = ((gear << 1) + GEAR_VALUES[content[position]]) & GEAR_MASK
            position += 1
            if position >= minimum and gear == 0:
                break
        yield content[start:position]
        start = position


def _unavailable() -> HTTPException:
    return HTTPException(
        status_code=503,
        detail="Recorded note revision is unavailable",
        headers={"Cache-Control": "private, no-store"},
    )


def _uuid(value: str | None) -> uuid.UUID | None:
    return uuid.UUID(value) if value is not None else None


class NoteHistoryContent:
    def __init__(self, db: AsyncSession):
        self.repo = NoteHistoryRepository(db)

    async def record(
        self,
        *,
        note_id: uuid.UUID,
        revision: int,
        snapshot: NoteSnapshot,
        capture_kind: str,
        operation: str,
        changed_fields: list[str],
        actor: dict | None,
        invocation_id: uuid.UUID | None = None,
        previous: NoteRevision | None = None,
        previous_content: str | None = None,
    ) -> NoteRevision:
        content = snapshot["content"].encode("utf-8")
        digests, prefix_bytes = await self._reusable_prefix(
            note_id, revision, content, previous, previous_content
        )
        chunks = {}
        for chunk in content_chunks(content[prefix_bytes:]):
            digest = hashlib.sha256(chunk).hexdigest()
            digests.append(digest)
            chunks[digest] = chunk
        recorded = await self.repo.add_revision(NoteRevision(
            note_id=note_id,
            revision=revision,
            capture_kind=capture_kind,
            operation=operation,
            changed_fields=list(changed_fields),
            content_bytes=len(content),
            content_sha256=hashlib.sha256(content).hexdigest(),
            revision_digest=revision_digest(snapshot),
            storage_version=STORAGE_VERSION,
            chunk_count=len(digests),
            title=snapshot["title"],
            pinned=snapshot["pinned"],
            card_id=_uuid(snapshot["card_id"]),
            kind=snapshot["kind"],
            failure_class=snapshot["failure_class"],
            findings=copy.deepcopy(snapshot["findings"]),
            source_execution_id=_uuid(snapshot["source_execution_id"]),
            actor=copy.deepcopy(actor),
            invocation_id=invocation_id,
        ))
        await self.repo.add_chunks(note_id, chunks)
        await self.repo.add_manifest(note_id, revision, digests)
        return recorded

    async def _reusable_prefix(
        self,
        note_id: uuid.UUID,
        revision: int,
        content: bytes,
        previous: NoteRevision | None,
        previous_content: str | None,
    ) -> tuple[list[str], int]:
        if (
            previous is None
            or previous_content is None
            or previous.note_id != note_id
            or previous.revision != revision - 1
            or previous.storage_version != STORAGE_VERSION
        ):
            return [], 0
        before = previous_content.encode("utf-8")
        if (
            len(before) != previous.content_bytes
            or hashlib.sha256(before).hexdigest() != previous.content_sha256
        ):
            return [], 0
        manifest = await self.repo.get_manifest_metadata(note_id, previous.revision)
        if len(manifest) != previous.chunk_count:
            return [], 0
        offset = 0
        reusable_bytes = 0
        digests = []
        matching_prefix = True
        unchanged = before == content
        for position, (stored_position, digest, size) in enumerate(manifest):
            last = position == len(manifest) - 1
            if (
                stored_position != position
                or size is None
                or not 0 < size <= MAX_CHUNK_BYTES
                or (not last and size < MIN_CHUNK_BYTES)
                or offset + size > len(before)
            ):
                return [], 0
            end = offset + size
            original = before[offset:end]
            if hashlib.sha256(original).hexdigest() != digest:
                return [], 0
            # Gear v1 restarts at each chunk. Reuse only complete, equal prefix
            # chunks; the old EOF fragment must be rechunked when bytes change.
            if matching_prefix and (unchanged or not last) and original == content[offset:end]:
                digests.append(digest)
                reusable_bytes = end
            else:
                matching_prefix = False
            offset = end
        if offset != len(before):
            return [], 0
        # Validate against the locked preimage, not stored payloads: a damaged
        # payload must keep its existing unavailable-read behavior, never become
        # a new write failure or be silently replaced as part of this optimization.
        return digests, reusable_bytes

    async def reconstruct(self, revision: NoteRevision) -> NoteSnapshot:
        if "findings" not in revision.__dict__:
            loaded = await self.repo.get(revision.note_id, revision.revision, with_snapshot=True)
            if loaded is None:
                raise _unavailable()
            revision = loaded
        if revision.storage_version != STORAGE_VERSION:
            raise _unavailable()
        manifest = await self.repo.get_manifest(revision.note_id, revision.revision)
        if len(manifest) != revision.chunk_count:
            raise _unavailable()
        if any(row.position != position for position, row in enumerate(manifest)):
            raise _unavailable()
        chunks = await self.repo.get_chunks(revision.note_id, [row.sha256 for row in manifest])
        payloads = []
        for row in manifest:
            chunk = chunks.get(row.sha256)
            if (
                chunk is None
                or len(chunk.payload) != chunk.content_bytes
                or not 0 < chunk.content_bytes <= MAX_CHUNK_BYTES
                or hashlib.sha256(chunk.payload).hexdigest() != row.sha256
            ):
                raise _unavailable()
            payloads.append(chunk.payload)
        encoded = b"".join(payloads)
        if (
            len(encoded) != revision.content_bytes
            or hashlib.sha256(encoded).hexdigest() != revision.content_sha256
        ):
            raise _unavailable()
        try:
            content = encoded.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            raise _unavailable() from None
        restored: NoteSnapshot = {
            "content": content,
            "title": revision.title,
            "pinned": revision.pinned,
            "card_id": str(revision.card_id) if revision.card_id is not None else None,
            "kind": revision.kind,
            "failure_class": revision.failure_class,
            "findings": copy.deepcopy(revision.findings),
            "source_execution_id": (
                str(revision.source_execution_id)
                if revision.source_execution_id is not None else None
            ),
        }
        try:
            digest = revision_digest(restored)
        except (ValueError, TypeError, UnicodeEncodeError):
            raise _unavailable() from None
        if digest != revision.revision_digest:
            raise _unavailable()
        return restored
