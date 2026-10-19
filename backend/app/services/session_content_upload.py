# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A device uploading the bodies it declared (contract §7 Upload).

A chunk is checked against its size and digest before anything is written,
staged, and only then recorded on the row. Finalize composes the chunks,
re-verifies the whole against the declaration, re-sniffs images, re-runs the
policy and placement checks against the current mapping, and makes the body
available. Store calls never run under a row lock; a store failure leaves the
upload where it was, for the device to retry. A device token reaches only
its own installation's uploads, and never reads a body back.

These routes run in the request's transaction (get_db; services never
commit), so it stays open across their store calls. That is accepted because
it holds no row lock then and each call is bounded: one chunk of at most
4 MiB per request, GCS calls time out, and the device gives up at 60 s."""

import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import as_utc
from app.exceptions import (
    ConflictError,
    GoneError,
    PayloadTooLargeError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.agent_session import AgentSessionContent, AgentSessionCaptureGeneration
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.repositories.session_content import SessionContentRepository
from app.schemas.session_content import (
    CHUNK_BYTES,
    PREVIEW_BYTES,
    TEXT_MEDIA_TYPES,
    WITH_BODY,
    ChunkReceipt,
    ContentUploadState,
    FinalizeRequest,
)
from app.services.rich_capture import grants_bodies, require_level_available
from app.services.session_content_ingest import (
    excluded,
    is_placed,
    mapping_roots,
    upload_slot,
)
from app.services.session_events import Invalidation, session_updated
from app.services.session_search_index import SessionSearchIndexWriter
from app.core.session_content_keys import (
    body_key,
    content_prefix,
    staging_key,
    staging_prefix,
)
from app.services.storage.session_content import ContentStore, content_store, stored

logger = logging.getLogger(__name__)

MAX_FINALIZE_FAILURES = 3
# The leading bytes each inline-renderable image type starts with.
_IMAGE_SIGNATURES = {
    "image/png": lambda head: head.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda head: head.startswith(b"\xff\xd8\xff"),
    "image/gif": lambda head: head.startswith((b"GIF87a", b"GIF89a")),
    "image/webp": lambda head: head[:4] == b"RIFF" and head[8:12] == b"WEBP",
    "image/avif": lambda head: head[4:8] == b"ftyp"
    and head[8:12] in (b"avif", b"avis"),
}


@dataclass(frozen=True)
class Finalized:
    """Finalize's answer, the invalidations to publish, and stored objects to
    delete once the transaction committed (never under its row locks; each is
    also queued, so a failed delete is retried by the purge). Text bodies it
    made available are indexed after commit too, outside its locks; each is
    recorded pending in the settlement, so one that fails stays reported
    pending rather than silently unsearchable."""

    answer: "ContentUploadState | UploadRefusal"
    invalidations: list[Invalidation]
    leftovers: list[str]
    index_content_ids: tuple[uuid.UUID, ...] = ()


@dataclass(frozen=True)
class UploadRefusal:
    """An error answer whose state change must still commit (a counted
    failed finalize, chunks found missing), so it is returned, not raised."""

    status_code: int
    error_code: str
    detail: str
    error_params: dict


def upload_state(content: AgentSessionContent) -> ContentUploadState:
    if content.state == "pending":
        return ContentUploadState(
            content_id=content.id,
            state="pending",
            coverage="not_yet_uploaded",
            coverage_reason="upload_pending",
            upload=upload_slot(content),
        )
    return ContentUploadState(
        content_id=content.id,
        state=content.state,
        coverage=content.coverage,
        coverage_reason=content.coverage_reason,
    )


def _not_found() -> ResourceNotFoundError:
    return ResourceNotFoundError("Content not found", error_code="content_not_found")


def _settled_conflict() -> ConflictError:
    return ConflictError(
        "This upload is settled; read its state", error_code="chunk_conflict"
    )


def _expired(content: AgentSessionContent) -> GoneError:
    return GoneError(
        "The upload was not finalized in time",
        error_code="upload_expired",
        error_params={"expired_at": as_utc(content.upload_expires_at).isoformat()},
    )


def _is_expired(content: AgentSessionContent, now: datetime) -> bool:
    if content.state == "recorded":
        return content.coverage == "expired"
    return content.state == "pending" and as_utc(content.upload_expires_at) <= now


def expected_chunk_size(content: AgentSessionContent, index: int) -> int:
    if index < content.chunk_count - 1:
        return CHUNK_BYTES
    return content.byte_count - CHUNK_BYTES * (content.chunk_count - 1)


def preview_of(body: bytes) -> str:
    return body[:PREVIEW_BYTES].decode("utf-8", errors="ignore")


def image_matches(media_type: str, body: bytes) -> bool:
    signature = _IMAGE_SIGNATURES.get(media_type)
    return signature is None or signature(body[:16])


class SessionContentUploadService:
    def __init__(self, db: AsyncSession, store: ContentStore | None = None):
        self.db = db
        self.repo = SessionContentRepository(db)
        self.store = store or content_store()

    @staticmethod
    def _require_rich_capture() -> None:
        require_level_available("rich")

    async def _content(self, installation, content_id, *, for_update=False):
        content = await self.repo.of_installation(
            content_id, installation.id, for_update=for_update
        )
        if content is None:
            raise _not_found()
        return content

    async def status(
        self, installation: CompanionInstallation, content_id: uuid.UUID
    ) -> ContentUploadState:
        return upload_state(await self._content(installation, content_id))

    # --- chunks ---

    async def put_chunk(
        self,
        installation: CompanionInstallation,
        content_id: uuid.UUID,
        index: int,
        chunk: bytes,
        digest: str,
    ) -> ChunkReceipt:
        self._require_rich_capture()
        content = await self._content(installation, content_id)
        now = datetime.now(timezone.utc)
        if _is_expired(content, now):
            raise _expired(content)
        if content.state != "pending":
            if (
                content.state == "available"
                and (content.received_chunks or {}).get(str(index))
                == hashlib.sha256(chunk).hexdigest()
            ):
                return self._receipt(content, index)
            raise _settled_conflict()
        self._check_chunk(content, index, chunk, digest)
        known = (content.received_chunks or {}).get(str(index))
        if known == digest:
            return self._receipt(content, index)
        if known is not None:
            raise ConflictError(
                "This chunk was received with other bytes", error_code="chunk_conflict"
            )
        key = staging_key(content, index)
        await stored(self.store.put, key, chunk)

        content = await self.repo.of_installation(
            content_id, installation.id, for_update=True
        )
        if content is None:
            # Deleted while the chunk was in flight: nothing may outlive it.
            await self._forget(key)
            raise _not_found()
        if content.state != "pending":
            raise _settled_conflict()
        known = (content.received_chunks or {}).get(str(index))
        if known is not None and known != digest:
            raise ConflictError(
                "This chunk was received with other bytes", error_code="chunk_conflict"
            )
        # A new JSON value, so the change is tracked.
        content.received_chunks = {
            **(content.received_chunks or {}),
            str(index): digest,
        }
        await self.db.flush()
        return self._receipt(content, index)

    @staticmethod
    def _check_chunk(content, index: int, chunk: bytes, digest: str) -> None:
        if not 0 <= index < content.chunk_count:
            raise ValidationError(
                "No such chunk",
                error_code="chunk_out_of_range",
                error_params={"chunk_count": content.chunk_count},
            )
        if len(chunk) > CHUNK_BYTES:
            raise PayloadTooLargeError(
                "A chunk holds at most chunk_bytes",
                error_code="chunk_too_large",
                error_params={"chunk_bytes": CHUNK_BYTES},
            )
        expected = expected_chunk_size(content, index)
        if len(chunk) != expected:
            raise ValidationError(
                "Every chunk but the last is chunk_bytes long; the last is the "
                "rest of the body",
                error_code="chunk_size_mismatch",
                error_params={"expected_bytes": expected, "received_bytes": len(chunk)},
            )
        if hashlib.sha256(chunk).hexdigest() != digest:
            raise ValidationError(
                "The chunk does not match its digest",
                error_code="chunk_checksum_mismatch",
            )

    @staticmethod
    def _receipt(content: AgentSessionContent, index: int) -> ChunkReceipt:
        received = sorted(int(known) for known in content.received_chunks or {})
        return ChunkReceipt(
            content_id=content.id,
            index=index,
            received_chunks=received,
            chunk_count=content.chunk_count,
            complete=len(received) == content.chunk_count,
        )

    # --- finalize ---

    async def finalize(
        self,
        installation: CompanionInstallation,
        content_id: uuid.UUID,
        request: FinalizeRequest,
    ) -> Finalized:
        self._require_rich_capture()
        content = await self._content(installation, content_id)
        now = datetime.now(timezone.utc)
        if _is_expired(content, now):
            raise _expired(content)
        if content.state == "available":
            return Finalized(upload_state(content), [], [])
        if content.state != "pending":
            raise _settled_conflict()
        if (request.byte_count, request.sha256) != (content.byte_count, content.sha256):
            raise ValidationError(
                "The body does not match its declaration",
                error_code="body_checksum_mismatch",
            )
        missing = [
            index
            for index in range(content.chunk_count)
            if str(index) not in (content.received_chunks or {})
        ]
        if missing:
            return Finalized(self._incomplete(missing), [], [])
        sources = [staging_key(content, index) for index in range(content.chunk_count)]
        destination = body_key(content)
        try:
            await stored(self.store.compose, sources, destination)
        except FileNotFoundError:
            return await self._staging_lost(installation, content_id, sources)
        body = await stored(self.store.read, destination)
        if len(body) != content.byte_count or (
            hashlib.sha256(body).hexdigest() != content.sha256
        ):
            return await self._checksum_failed(installation, content_id)
        outcome = await self._policy_outcome(installation, content, body)
        return await self._settle(installation, content_id, body, outcome, destination)

    @staticmethod
    def _incomplete(missing: list[int]) -> UploadRefusal:
        return UploadRefusal(
            409, "upload_incomplete", "Chunks are missing", {"missing_chunks": missing}
        )

    async def _staging_lost(self, installation, content_id, sources) -> Finalized:
        """A chunk the row counts is gone from the store: forget it, so the
        device sends it again. The store is asked before the row is locked."""
        present = [await stored(self.store.stat, key) is not None for key in sources]
        content = await self._content(installation, content_id, for_update=True)
        if content.state == "available":
            return Finalized(upload_state(content), [], [])
        content.received_chunks = {
            index: digest
            for index, digest in (content.received_chunks or {}).items()
            if present[int(index)]
        }
        await self.db.flush()
        missing = [index for index, kept in enumerate(present) if not kept]
        return Finalized(self._incomplete(missing), [], [])

    async def _checksum_failed(self, installation, content_id) -> Finalized:
        """Discard the attempt's chunks. Its objects stay where they are: a
        retry rewrites the same keys, and only settling the upload (here on
        the last attempt, or at expiry) queues them for deletion, so no purge
        can ever race a retry for them."""
        session = await self._locked_session_of(installation, content_id)
        content = await self._content(installation, content_id, for_update=True)
        if content.state != "pending":
            return Finalized(upload_state(content), [], [])
        content.finalize_failures += 1
        content.received_chunks = {}
        if content.finalize_failures >= MAX_FINALIZE_FAILURES:
            await self._record(session, content, ("collection_failed", "upload_failed"))
        await self.db.flush()
        refusal = UploadRefusal(
            422,
            "body_checksum_mismatch",
            "The body does not match the declared digest; its chunks were discarded",
            {"attempts": content.finalize_failures},
        )
        return Finalized(refusal, [], [])

    async def _policy_outcome(
        self,
        installation: CompanionInstallation,
        content: AgentSessionContent,
        body: bytes,
    ) -> tuple[str, str] | None:
        """Why the body cannot be kept now, re-judged against the current
        mapping; None when it can. Pausing is not re-judged: it governs what
        is captured, not what is delivered."""
        if content.channel == "attachment" and not image_matches(
            content.media_type, body
        ):
            return "withheld_by_policy", "media_type_not_permitted"
        mapping = await self._mapping_of(content)
        if mapping is None or not grants_bodies(mapping, installation):
            return "withheld_by_policy", "content_level"
        if excluded(content.display_path, installation):
            return "withheld_by_policy", "excluded_path"
        if content.media_type in TEXT_MEDIA_TYPES and not is_placed(
            body.decode("utf-8", errors="replace"),
            content.media_type,
            mapping_roots(mapping),
        ):
            return "collection_failed", "placement_failed"
        return None

    async def _mapping_of(self, content) -> CompanionProjectMapping | None:
        generation = await self.db.get(
            AgentSessionCaptureGeneration, content.generation_id
        )
        if generation is None or generation.mapping_id is None:
            return None
        return await self.db.get(CompanionProjectMapping, generation.mapping_id)

    async def _settle(
        self, installation, content_id, body: bytes, outcome, composed: str
    ) -> Finalized:
        if await self.repo.of_installation(content_id, installation.id) is None:
            # Deleted while composing; no lock is held yet, so drop the body
            # just written now (the sweep catches a later race).
            await self._forget(composed)
            raise _not_found()
        session = await self._locked_session_of(installation, content_id)
        content = await self.repo.of_installation(
            content_id, installation.id, for_update=True
        )
        if session is None or content is None:
            raise _not_found()
        if content.state == "recorded":
            # Settled (expired) meanwhile: the body composed after it goes too.
            await self.repo.queue_deletions(
                self.store.backend, [composed], datetime.now(timezone.utc)
            )
            return Finalized(upload_state(content), [], [composed])
        if content.state != "pending":
            return Finalized(upload_state(content), [], [])
        now = datetime.now(timezone.utc)
        if outcome is not None:
            await self._record(session, content, outcome)
            await self.db.flush()
            return Finalized(upload_state(content), [], [content_prefix(content)])
        content.state = "available"
        content.coverage = content.declared_coverage
        content.coverage_reason = content.declared_coverage_reason
        content.storage_backend = self.store.backend
        content.storage_key = body_key(content)
        content.available_at = now
        is_text = content.media_type in TEXT_MEDIA_TYPES
        if is_text:
            content.preview = preview_of(body)
            await SessionSearchIndexWriter(self.db).mark_pending(content)
        # Staging is deleted after commit, and queued in case that fails.
        await self.repo.queue_deletions(
            self.store.backend, [staging_prefix(content)], now
        )
        await self.db.flush()
        return Finalized(
            upload_state(content),
            [session_updated(session, "content_available")],
            [staging_prefix(content)],
            (content.id,) if is_text else (),
        )

    async def _record(self, session, content: AgentSessionContent, coverage) -> None:
        """Settle without a body: release its reservation and queue whatever
        of it was stored."""
        content.state = "recorded"
        content.coverage, content.coverage_reason = coverage
        content.upload_expires_at = None
        if content.declared_coverage in WITH_BODY and content.byte_count:
            session.content_bytes -= content.byte_count
            await self.repo.add_installation_bytes(
                content.installation_id, -content.byte_count
            )
        await self.repo.queue_deletions(
            self.store.backend, [content_prefix(content)], datetime.now(timezone.utc)
        )

    async def _forget(self, key: str) -> None:
        try:
            await stored(self.store.delete_prefix, key)
        except Exception:
            logger.warning("orphaned content object %s left for the sweep", key)

    async def delete_leftovers(self, prefixes: list[str]) -> None:
        """After commit: delete what a settled upload left; each is queued as
        well, so a failure here is retried by the purge."""
        for prefix in prefixes:
            await self._forget(prefix)

    async def _locked_session_of(self, installation, content_id):
        content = await self.repo.of_installation(content_id, installation.id)
        if content is None:
            raise _not_found()
        return await self.repo.lock_session(content.session_id)
