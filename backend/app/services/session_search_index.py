# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Writing a session's search index, one exact source at a time.

Events and inline bodies are indexed by `SessionSearchIndexWriter` in the
transaction that stored them (or the caller's, for a retained source written
before search existed); it only flushes. An uploaded body is read outside any
transaction by `SessionSearchObjectProcessor.prepare_source`, then written by
`index_prepared_source` in a short transaction that locks the session, then
the content, and writes nothing unless the source is still exactly what was
read: deletion, retraction or a new digest always wins over a late write.

The generation moves only when a session's searchable chunks change, so an
identical retry neither duplicates chunks nor restarts anyone's search."""

import hashlib
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.concurrency import run_in_threadpool

from app.core.time import as_utc
from app.exceptions import StorageBackendUnavailableError
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.repositories.session_calls import CALL_PREFIX, EVENT_PREFIX
from app.repositories.session_search import (
    ObjectDescriptor,
    SessionSearchRepository,
    SourceRecord,
)
from app.schemas.session_content import (
    MAX_TEXT_BODY_BYTES,
    TEXT_MEDIA_TYPES,
    WITH_BODY,
)
from app.services.session_search_text import (
    EXTRACTOR_VERSION,
    EventSegment,
    TextChunk,
    content_chunks,
    event_chunks,
    event_digest,
    event_segments,
)
from app.services.storage.session_content import store_for, stored

logger = logging.getLogger(__name__)

EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

SourceKind = Literal["content", "event"]
IndexOutcome = Literal[
    "indexed",  # chunks written (or replaced) for the current digest
    "unchanged",  # already indexed exactly so
    "pending",  # an uploaded body waits for its object read
    "unavailable",  # recorded as unreadable: missing, wrong size or digest
    "not_text",  # recorded as text that is not valid UTF-8
    "ineligible",  # not retained text, or its owner left the workspace
    "stale",  # changed since the caller (or preparation) read it
    "absent",  # deleted
]
PrepareOutcome = Literal[
    "ready",
    "absent",
    "ineligible",
    "stale",
    "storage_unavailable",
    "missing_object",
    "wrong_size",
    "digest_mismatch",
    "invalid_utf8",
]
_RECORDED_OUTCOMES: dict[str, tuple[str, str]] = {
    "missing_object": ("unavailable", "missing_object"),
    "wrong_size": ("unavailable", "wrong_size"),
    "digest_mismatch": ("unavailable", "digest_mismatch"),
    "invalid_utf8": ("not_text", "invalid_utf8"),
}


def is_search_text(content: AgentSessionContent | ObjectDescriptor) -> bool:
    return (
        content.state == "available"
        and content.coverage in WITH_BODY
        and content.media_type in TEXT_MEDIA_TYPES
        and content.sha256 is not None
    )


def sort_microseconds(at: datetime) -> int:
    return (as_utc(at) - EPOCH) // timedelta(microseconds=1)


def content_anchor(call_key: str | None) -> str | None:
    return CALL_PREFIX + call_key if call_key else None


def event_anchor(native_tool_call_id: str | None, event_id: str) -> str:
    if native_tool_call_id:
        return CALL_PREFIX + native_tool_call_id
    return EVENT_PREFIX + event_id


@dataclass(frozen=True)
class PreparedSource:
    """An uploaded body as read from the store, with the identity it was
    read under. Never an ORM object: it outlives the session that read it."""

    content_id: uuid.UUID
    outcome: PrepareOutcome
    descriptor: ObjectDescriptor | None = None
    chunks: tuple[TextChunk, ...] = field(default=(), repr=False)
    extractor_version: str = EXTRACTOR_VERSION


class SessionSearchIndexWriter:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = SessionSearchRepository(db)

    async def index_source(
        self,
        source_kind: SourceKind,
        source_id: uuid.UUID,
        expected_digest: str | None = None,
        expected_version: str | None = None,
    ) -> IndexOutcome:
        """Index one retained event or inline body exactly as stored now,
        idempotently. An uploaded body only becomes pending: its object is
        never read inside the caller's transaction."""
        if expected_version is not None and expected_version != EXTRACTOR_VERSION:
            return "stale"
        if source_kind == "event":
            return await self._index_event(source_id, expected_digest)
        if source_kind == "content":
            return await self._index_content(source_id, expected_digest)
        raise ValueError(f"unknown search source kind {source_kind!r}")

    async def index_new_contents(
        self, session: AgentSession, contents: list[AgentSessionContent]
    ) -> None:
        """Inline bodies just accepted under the caller's lock on `session`."""
        await self._insert_new(
            session,
            [
                _inline_record(content)
                for content in contents
                if is_search_text(content) and content.inline_text is not None
            ],
        )

    async def index_new_events(self, session: AgentSession, rows: list[dict]) -> None:
        """Events just inserted under the caller's lock on `session`, from the
        exact values stored (already reduced to the mapping's content level)."""
        await self._insert_new(
            session,
            [
                _event_record(
                    session.id,
                    row["id"],
                    event_anchor(row["native_tool_call_id"], row["event_id"]),
                    row["occurred_at"],
                    event_segments(row["event"]),
                )
                for row in rows
            ],
        )

    async def mark_pending(self, content: AgentSessionContent) -> None:
        """An uploaded text body just made available: durable proof it still
        needs its object read, written with the settlement it follows. It
        replaces only rows no scan reads any more (another digest or
        extractor), so the generation stays."""
        await self.repo.mark_content_pending(
            _content_record(content, "pending", None, [], indexed=False).values
        )
        await self.db.flush()

    async def index_prepared_source(self, prepared: PreparedSource) -> IndexOutcome:
        if prepared.outcome == "absent" or prepared.descriptor is None:
            return "absent"
        if prepared.outcome in ("stale", "ineligible"):
            return prepared.outcome
        if prepared.outcome == "storage_unavailable":
            return "pending"
        read = prepared.descriptor
        session = await self.repo.lock_session(read.session_id)
        content = await self.repo.lock_content(read.content_id)
        if session is None or content is None:
            return "absent"
        if not self._still_as_read(session, content, prepared):
            return "stale"
        if not await self.repo.is_member(session.workspace_id, session.owner_id):
            return "ineligible"
        existing = await self.repo.source_of_content(content.id)
        if prepared.outcome == "ready":
            record = _content_record(content, "indexed", None, list(prepared.chunks))
        else:
            status, reason = _RECORDED_OUTCOMES[prepared.outcome]
            record = _content_record(content, status, reason, [])
        return await self._replace(session, existing, record)

    # --- exact sources ---

    async def _index_content(
        self, content_id: uuid.UUID, expected_digest: str | None
    ) -> IndexOutcome:
        session_id = await self.repo.session_of_content(content_id)
        if session_id is None:
            return "absent"
        session = await self.repo.lock_session(session_id)
        content = await self.repo.lock_content(content_id)
        if session is None or content is None or content.session_id != session.id:
            return "absent"
        if expected_digest is not None and content.sha256 != expected_digest:
            return "stale"
        if not is_search_text(content):
            return "ineligible"
        existing = await self.repo.source_of_content(content.id)
        if content.inline_text is not None:
            return await self._replace(session, existing, _inline_record(content))
        for status in ("indexed", "unavailable", "not_text"):
            if _is_current(existing, status, content.sha256):
                return "unchanged" if status == "indexed" else status
        if not _is_current(existing, "pending", content.sha256):
            await self.mark_pending(content)
        return "pending"

    async def _index_event(
        self, event_id: uuid.UUID, expected_digest: str | None
    ) -> IndexOutcome:
        session_id = await self.repo.session_of_event(event_id)
        if session_id is None:
            return "absent"
        session = await self.repo.lock_session(session_id)
        event = await self.repo.event(event_id)
        if session is None or event is None or event.session_id != session.id:
            return "absent"
        record = _event_record(
            session.id,
            event.id,
            event_anchor(event.native_tool_call_id, event.event_id),
            event.occurred_at,
            event_segments(event.event),
        )
        if expected_digest is not None and record.digest != expected_digest:
            return "stale"
        return await self._replace(
            session, await self.repo.source_of_event(event.id), record
        )

    # --- writes ---

    async def _insert_new(
        self, session: AgentSession, records: list[SourceRecord]
    ) -> None:
        """Sources no index row can exist for yet, in one batch."""
        if records:
            await self.repo.insert_sources(records)
        await self._finish(session, any(record.chunks for record in records))

    async def _replace(
        self,
        session: AgentSession,
        existing: SessionSearchSource | None,
        record: SourceRecord,
    ) -> IndexOutcome:
        status = record.values["status"]
        if _is_current(existing, status, record.digest):
            return "unchanged" if status == "indexed" else status
        # Read before the replacement overwrites the row: removing chunks
        # changes what a scan reads just as adding them does.
        had_chunks = bool(existing and existing.chunk_count)
        await self.repo.replace_source(existing, record)
        await self._finish(session, bool(record.chunks) or had_chunks)
        return status

    async def _finish(self, session: AgentSession, changed: bool) -> None:
        if changed:
            await self.repo.bump_generation(session.id, datetime.now(timezone.utc))
        await self.db.flush()

    @staticmethod
    def _still_as_read(
        session: AgentSession, content: AgentSessionContent, prepared: PreparedSource
    ) -> bool:
        read = prepared.descriptor
        return (
            prepared.extractor_version == EXTRACTOR_VERSION
            and content.session_id == session.id == read.session_id
            and (content.workspace_id, content.owner_id, content.installation_id)
            == (read.workspace_id, read.owner_id, read.installation_id)
            and (session.workspace_id, session.owner_id)
            == (read.workspace_id, read.owner_id)
            and is_search_text(content)
            and (
                content.sha256,
                content.byte_count,
                content.media_type,
                content.storage_backend,
                content.storage_key,
                content.inline_text,
            )
            == (
                read.sha256,
                read.byte_count,
                read.media_type,
                read.storage_backend,
                read.storage_key,
                read.inline_text,
            )
        )


def _inline_record(content: AgentSessionContent) -> SourceRecord:
    encoded = content.inline_text.encode()
    if (
        len(encoded) != content.byte_count
        or hashlib.sha256(encoded).hexdigest() != content.sha256
    ):
        return _content_record(content, "unavailable", "digest_mismatch", [])
    chunks = content_chunks(content.inline_text, content.channel)
    return _content_record(content, "indexed", None, chunks)


def _content_record(
    content: AgentSessionContent,
    status: str,
    reason: str | None,
    chunks: list[TextChunk],
    *,
    indexed: bool = True,
) -> SourceRecord:
    return SourceRecord(
        values=dict(
            session_id=content.session_id,
            content_id=content.id,
            event_id=None,
            status=status,
            reason=reason,
            extractor_version=EXTRACTOR_VERSION,
            source_digest=content.sha256,
            byte_count=content.byte_count,
            folded_bytes=sum(chunk.owned_bytes for chunk in chunks),
            chunk_count=len(chunks),
            call_anchor=content_anchor(content.call_key),
            indexed_at=datetime.now(timezone.utc) if indexed else None,
        ),
        chunks=chunks,
        sort_us=sort_microseconds(content.occurred_at),
        sort_order=content.source_order,
    )


def _event_record(
    session_id: uuid.UUID,
    event_id: uuid.UUID,
    call_anchor: str,
    occurred_at: datetime,
    segments: list[EventSegment],
) -> SourceRecord:
    chunks = event_chunks(segments)
    return SourceRecord(
        values=dict(
            session_id=session_id,
            content_id=None,
            event_id=event_id,
            status="indexed",
            reason=None,
            extractor_version=EXTRACTOR_VERSION,
            source_digest=event_digest(segments),
            byte_count=sum(len(segment.text.encode()) for segment in segments),
            folded_bytes=sum(chunk.owned_bytes for chunk in chunks),
            chunk_count=len(chunks),
            call_anchor=call_anchor,
            indexed_at=datetime.now(timezone.utc),
        ),
        chunks=chunks,
        sort_us=sort_microseconds(occurred_at),
        sort_order=0,
    )


def _is_current(
    source: SessionSearchSource | None, status: str, digest: str | None
) -> bool:
    return (
        source is not None
        and source.status == status
        and source.extractor_version == EXTRACTOR_VERSION
        and source.source_digest == digest
    )


class SessionSearchObjectProcessor:
    """Reads an uploaded body for the index outside any database transaction.

    `process_source` is the normal single-source step after a finalize
    commits; it takes a fresh session from `session_factory` for each of its
    two short transactions and never the request's. A failure leaves the
    source pending, as coverage reports it, for a later index run."""

    def __init__(self, session_factory: async_sessionmaker):
        self.session_factory = session_factory

    async def prepare_source(
        self,
        content_id: uuid.UUID,
        expected_digest: str | None = None,
        expected_version: str | None = None,
    ) -> PreparedSource:
        if expected_version is not None and expected_version != EXTRACTOR_VERSION:
            return PreparedSource(content_id, "stale")
        async with self.session_factory() as db:
            async with db.begin():
                read = await SessionSearchRepository(db).object_descriptor(content_id)
        # The read transaction is over: no lock or snapshot is held while the
        # body is fetched, hashed and folded.
        if read is None:
            return PreparedSource(content_id, "absent")
        if expected_digest is not None and read.sha256 != expected_digest:
            return PreparedSource(content_id, "stale", read)
        if not is_search_text(read) or (read.byte_count or 0) > MAX_TEXT_BODY_BYTES:
            return PreparedSource(content_id, "ineligible", read)
        if read.inline_text is not None:
            body = read.inline_text.encode()
        else:
            outcome, body = await self._read_object(read)
            if outcome is not None:
                return PreparedSource(content_id, outcome, read)
        if len(body) != read.byte_count:
            return PreparedSource(content_id, "wrong_size", read)
        if hashlib.sha256(body).hexdigest() != read.sha256:
            return PreparedSource(content_id, "digest_mismatch", read)
        try:
            text = body.decode("utf-8")
        except UnicodeDecodeError:
            return PreparedSource(content_id, "invalid_utf8", read)
        del body
        chunks = await run_in_threadpool(content_chunks, text, read.channel)
        return PreparedSource(content_id, "ready", read, tuple(chunks))

    async def process_source(
        self,
        content_id: uuid.UUID,
        expected_digest: str | None = None,
        expected_version: str | None = None,
    ) -> IndexOutcome | None:
        try:
            prepared = await self.prepare_source(
                content_id,
                expected_digest=expected_digest,
                expected_version=expected_version,
            )
            async with self.session_factory() as db:
                async with db.begin():
                    return await SessionSearchIndexWriter(db).index_prepared_source(
                        prepared
                    )
        except Exception as error:
            # Never the body, key or storage message: only which source waits.
            logger.warning(
                "session search left content %s pending (%s)",
                content_id,
                type(error).__name__,
            )
            return None

    @staticmethod
    async def _read_object(
        read: ObjectDescriptor,
    ) -> tuple[PrepareOutcome | None, bytes]:
        store = store_for(read.storage_backend) if read.storage_backend else None
        if store is None or read.storage_key is None:
            return "storage_unavailable", b""
        try:
            found = await stored(store.stat, read.storage_key)
            if found is None:
                return "missing_object", b""
            if found.size != read.byte_count:
                return "wrong_size", b""
            # One byte past the declared size, so a longer object is caught.
            body = await stored(store.read, read.storage_key, 0, read.byte_count + 1)
        except (FileNotFoundError, ValueError):
            return "missing_object", b""
        except StorageBackendUnavailableError:
            return "storage_unavailable", b""
        return None, body
