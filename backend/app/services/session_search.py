# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The owner searching one session's retained text and calls.

Search reads the index, never whole bodies: a request scans a bounded window
of folded chunks in chronological order and reads back only the bytes around
the hits it returns (at most 2 KiB each), checking that they are still
exactly what was indexed. A source that no longer matches is reported
unavailable, without a snippet. Authorization is the content reader's own
(the owner, while a member; never an agent's key or one the companion handed
out) and is checked again after storage reads, before private bytes go out."""

import asyncio
import base64
import binascii
import hashlib
import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import NoReturn

from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import (
    ConflictError,
    StorageBackendUnavailableError,
    ValidationError,
)
from app.models.agent_session import AgentSession
from app.repositories.session_calls import CALL_PREFIX
from app.repositories.session_search import (
    ContentCoverageRow,
    MatchingChunk,
    ScanPosition,
    SearchScope,
    SessionSearchRepository,
    WindowChunk,
)
from app.schemas.session_content import WITH_BODY
from app.schemas.session_search import (
    CoverageCount,
    LinkedChildMetadata,
    SessionSearchCoverage,
    SessionSearchHit,
    SessionSearchPage,
    SessionSearchRequest,
)
from app.services.session_calls import SessionCallService, call_key
from app.services.session_content import AgentSessionContentService
from app.services.session_search_index import EPOCH, is_search_text
from app.services.session_search_text import (
    EXTRACTOR_VERSION,
    event_digest,
    event_leaf,
    event_segments,
    fold,
    snippet_range,
    snippet_text,
)
from app.services.storage.session_content import store_for, stored

SCAN_BYTES = 8 << 20
# Bounds one request's window when sources are tiny (events, short replies).
MAX_WINDOW_CHUNKS = 2048
OBJECT_READ_CONCURRENCY = 4
CALL_TYPES = frozenset({"tool", "mcp", "subagent"})
COVERAGE_BUCKETS = (
    "indexed",
    "pending_index",
    "pending_upload",
    "withheld",
    "uncaptured",
    "unavailable",
    "nontext",
    "available",
)


def _stale() -> ConflictError:
    return ConflictError(
        "This session's searchable text or calls changed; search again",
        error_code="session_search_stale",
    )


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()[:32]


def _field_key(field: str) -> str:
    """A fixed-size identity for a field, whose path can be arbitrarily long."""
    return hashlib.sha256(field.encode()).hexdigest()[:32]


@dataclass(frozen=True)
class SearchCursor:
    """Where a scan stopped: a chunk and a folded offset inside it, bound to
    the session, query and filters that produced it (`binding`) and to the
    index generation and live call sets they saw (`fingerprint`). `last_hit`
    is where the previous page's last hit ended, so the next page never
    returns a hit overlapping it. Every member is fixed-size, so an issued
    cursor always fits the request's cursor bound."""

    session_id: uuid.UUID
    binding: str
    fingerprint: str
    position: ScanPosition
    resume_chars: int
    resume_bytes: int
    last_hit: "_HitEnd | None" = None

    def encode(self) -> str:
        sort_us, sort_order, source_id, ordinal = self.position
        raw = json.dumps(
            {
                "v": 1,
                "s": str(self.session_id),
                "b": self.binding,
                "f": self.fingerprint,
                "p": [sort_us, sort_order, str(source_id), ordinal],
                "c": self.resume_chars,
                "y": self.resume_bytes,
                "h": (
                    [
                        str(self.last_hit.source_id),
                        self.last_hit.field_key,
                        self.last_hit.byte_end,
                    ]
                    if self.last_hit is not None
                    else None
                ),
            },
            separators=(",", ":"),
        ).encode()
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @classmethod
    def decode(cls, cursor: str, session_id: uuid.UUID, binding: str) -> "SearchCursor":
        """The cursor, if this session, query and filters issued it."""
        try:
            payload = json.loads(
                base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
            )
            sort_us, sort_order, source_id, ordinal = payload["p"]
            last_hit = None
            if payload["h"] is not None:
                hit_source, hit_field_key, hit_end = payload["h"]
                if not _is_field_key(hit_field_key) or type(hit_end) is not int:
                    raise ValueError
                last_hit = _HitEnd(uuid.UUID(hit_source), hit_field_key, hit_end)
            decoded = cls(
                session_id=uuid.UUID(payload["s"]),
                binding=payload["b"],
                fingerprint=payload["f"],
                position=(sort_us, sort_order, uuid.UUID(source_id), ordinal),
                resume_chars=payload["c"],
                resume_bytes=payload["y"],
                last_hit=last_hit,
            )
            counts = (ordinal, decoded.resume_chars, decoded.resume_bytes)
            if (
                payload["v"] != 1
                or not all(type(n) is int for n in (sort_us, sort_order, *counts))
                or min(counts) < 0
                or not isinstance(decoded.fingerprint, str)
            ):
                raise ValueError
        except (ValueError, TypeError, KeyError, AttributeError, binascii.Error):
            raise ValidationError("Invalid cursor") from None
        if decoded.session_id != session_id or decoded.binding != binding:
            raise ValidationError("This cursor belongs to another search")
        return decoded


def _is_field_key(value) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 32
        and all(character in "0123456789abcdef" for character in value)
    )


@dataclass(frozen=True)
class _HitEnd:
    source_id: uuid.UUID
    field_key: str
    byte_end: int

    def overlaps(self, hit: "_Hit", field_key: str) -> bool:
        return (
            self.source_id == hit.chunk.source_id
            and self.field_key == field_key
            and hit.byte_start < self.byte_end
        )


@dataclass
class _Hit:
    chunk: MatchingChunk
    byte_start: int
    byte_end: int
    # The original bytes the index says the match covers.
    expected: bytes
    event_id: str | None = None
    snippet: str | None = None
    snippet_byte_start: int | None = None
    available: bool = False
    # The source row is gone: deletion wins, so the hit leaves the page.
    deleted: bool = False
    # The content's (storage backend, key) when its row was read.
    storage: tuple[str | None, str | None] | None = None

    def verified(self, cut: tuple[str, int] | None) -> None:
        if cut is not None:
            self.snippet, self.snippet_byte_start = cut
            self.available = True

    def withdraw(self) -> None:
        self.snippet, self.snippet_byte_start, self.available = None, None, False


@dataclass
class _Scan:
    hits: list[_Hit]
    scanned_bytes: int
    # (chunk position, folded chars and bytes of it already scanned)
    resume: tuple[ScanPosition, int, int] | None
    last_hit: _HitEnd | None


@dataclass
class _Tally:
    count: int = 0
    total: int = 0
    unknown: bool = False

    def add(self, count: int, total: int, known: int) -> None:
        self.count += count
        self.total += total
        self.unknown |= known < count

    def read(self) -> CoverageCount:
        return CoverageCount(
            count=self.count, bytes=None if self.unknown else self.total
        )


@dataclass
class _Coverage:
    buckets: dict[str, _Tally] = field(
        default_factory=lambda: {name: _Tally() for name in COVERAGE_BUCKETS}
    )

    def add(self, name: str, count: int, total: int, known: int) -> None:
        self.buckets[name].add(count, total, known)


class SessionSearchService(AgentSessionContentService):
    def __init__(self, db: AsyncSession):
        super().__init__(db)
        self.index = SessionSearchRepository(db)
        self.calls = SessionCallService(db)

    async def search(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        request: SessionSearchRequest,
    ) -> SessionSearchPage:
        session = await self._owned_session(workspace_id, owner_id, session_id)
        query = fold(request.q)
        types = frozenset(request.types) if request.types else None
        binding = _digest(
            [
                str(session.id),
                query,
                sorted(types) if types is not None else None,
                request.failures_only,
                request.work_only,
            ]
        )
        cursor = (
            SearchCursor.decode(request.cursor, session.id, binding)
            if request.cursor is not None
            else None
        )
        scope = await self._scope(session, types, request)
        generation, eligible_bytes, fingerprint = await self._snapshot(
            session.id, scope
        )
        if cursor is not None and cursor.fingerprint != fingerprint:
            raise _stale()
        scan = await self._scan(session.id, scope, query, cursor, request.limit)
        if scan is None:
            await self._refuse_resume(
                workspace_id, owner_id, session_id, types, request, cursor
            )
        await self._verify_hits(scan.hits)
        # Storage reads were awaited: the owner may have lost access or a body
        # may have changed meanwhile. Either wins over what was read.
        session = await self._owned_session(workspace_id, owner_id, session_id)
        await self._recheck_objects(scan.hits)
        hits = [hit for hit in scan.hits if not hit.deleted]
        if hits and _live_sets(scope) != _live_sets(
            await self._scope(session, types, request)
        ):
            raise ConflictError(
                "The calls this search filters on changed while it ran; search again",
                error_code="session_search_stale",
            )
        next_cursor = None
        if scan.resume is not None:
            position, resume_chars, resume_bytes = scan.resume
            next_cursor = SearchCursor(
                session.id,
                binding,
                fingerprint,
                position,
                resume_chars,
                resume_bytes,
                scan.last_hit,
            ).encode()
        return SessionSearchPage(
            items=[self._item(hit) for hit in hits],
            generation=generation,
            scanned_bytes=scan.scanned_bytes,
            eligible_bytes=eligible_bytes,
            next_cursor=next_cursor,
            complete=next_cursor is None,
            coverage=await self._coverage(session, hits),
        )

    async def _snapshot(
        self, session_id: uuid.UUID, scope: SearchScope
    ) -> tuple[int, int, str]:
        """(generation, eligible bytes, fingerprint) of what a scan of this
        scope reads now; a cursor is valid only while its fingerprint is."""
        generation = await self.index.generation(session_id)
        eligible_sources, eligible_bytes = await self.index.eligible_totals(
            session_id, scope
        )
        fingerprint = _digest(
            [
                generation,
                eligible_sources,
                eligible_bytes,
                *(
                    sorted(anchors) if anchors is not None else None
                    for anchors in _live_sets(scope)
                ),
            ]
        )
        return generation, eligible_bytes, fingerprint

    async def _refuse_resume(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        types: frozenset[str] | None,
        request: SessionSearchRequest,
        cursor: SearchCursor,
    ) -> NoReturn:
        """A cursor whose resume point is not a real prefix of its chunk. The
        index may have changed after the fingerprint was checked (a chunk
        removed before or during the prefix read): that is a stale search, not
        a malformed cursor. Only an unchanged index makes the cursor invalid.
        Current authorization still comes first."""
        session = await self._owned_session(workspace_id, owner_id, session_id)
        scope = await self._scope(session, types, request)
        if (await self._snapshot(session.id, scope))[2] != cursor.fingerprint:
            raise _stale()
        raise ValidationError("Invalid cursor")

    async def _scope(
        self,
        session: AgentSession,
        types: frozenset[str] | None,
        request: SessionSearchRequest,
    ) -> SearchScope:
        tool_anchors = mcp_anchors = None
        if types is not None and types & {"tool", "mcp"}:
            kinds = await self.index.call_kinds(session.id)
            if "tool" in types:
                tool_anchors = frozenset(
                    a for a, kind in kinds.items() if kind == "tool"
                )
            if "mcp" in types:
                mcp_anchors = frozenset(a for a, kind in kinds.items() if kind == "mcp")
        failed_anchors = work_anchors = None
        if request.failures_only:
            failed_anchors = await self.index.failed_anchors(session.id)
        if request.work_only:
            work_anchors = frozenset(
                CALL_PREFIX + call_id
                for call_id in await self.calls.work_call_ids(session)
            )
        return SearchScope(
            extractor_version=EXTRACTOR_VERSION,
            channels=types - CALL_TYPES if types is not None else None,
            tool_alias=types is not None and "tool" in types,
            tool_anchors=tool_anchors,
            mcp_anchors=mcp_anchors,
            failed_anchors=failed_anchors,
            work_anchors=work_anchors,
        )

    # --- the bounded scan ---

    async def _scan(
        self,
        session_id: uuid.UUID,
        scope: SearchScope,
        query: str,
        cursor: SearchCursor | None,
        limit: int,
    ) -> _Scan | None:
        """The page, or None when the cursor's resume point is not a real
        prefix of its chunk in this scan."""
        window = await self.index.scan_window(
            session_id,
            scope,
            cursor.position if cursor is not None else None,
            MAX_WINDOW_CHUNKS + 1,
        )
        if (
            cursor is not None
            and (cursor.resume_chars, cursor.resume_bytes) != (0, 0)
            and not await self._is_resume_prefix(window, cursor)
        ):
            return None
        selected: list[WindowChunk] = []
        budget = 0
        for chunk in window[:MAX_WINDOW_CHUNKS]:
            size = chunk.owned_bytes - _resumed(chunk, cursor)[1]
            if selected and budget + size > SCAN_BYTES:
                break
            selected.append(chunk)
            budget += size
        matching = await self.index.matching_chunks(
            [chunk.id for chunk in selected], query
        )
        hits: list[_Hit] = []
        scanned = 0
        last = cursor.last_hit if cursor is not None else None
        for chunk in selected:
            from_char, from_byte = _resumed(chunk, cursor)
            found = matching.get(chunk.id)
            if found is not None:
                folded = found.text.folded
                offsets = _ByteOffsets(found)
                field_key = _field_key(found.field)
                occurrence = folded.find(query, from_char)
                while occurrence != -1 and occurrence < found.owned_chars:
                    hit = offsets.hit(occurrence, len(query))
                    # Hits are leftmost and never overlap; folded matches
                    # inside one expansion (`s` twice in `ß`) are one hit.
                    if last is None or not last.overlaps(hit, field_key):
                        if len(hits) == limit:
                            # Stop at the first hit past the page, so the next
                            # page starts on it and a full page that ends the
                            # data is complete.
                            done = len(folded[from_char:occurrence].encode())
                            return _Scan(
                                hits,
                                scanned + done,
                                (chunk.position, occurrence, from_byte + done),
                                last,
                            )
                        hits.append(hit)
                        last = _HitEnd(found.source_id, field_key, hit.byte_end)
                    occurrence = folded.find(query, occurrence + 1)
            scanned += chunk.owned_bytes - from_byte
        following = window[len(selected)] if len(window) > len(selected) else None
        return _Scan(
            hits,
            scanned,
            (following.position, 0, 0) if following is not None else None,
            last,
        )

    async def _is_resume_prefix(
        self, window: list[WindowChunk], cursor: SearchCursor
    ) -> bool:
        """A cursor that resumes inside a chunk must name that chunk of this
        scan and a real prefix of what it owns: `resume_chars` folded
        characters whose UTF-8 encoding is exactly `resume_bytes`. The token
        is not signed, and those bytes are subtracted from the scan budget and
        from `scanned_bytes`, so any other pair is refused before either."""
        resumed = (
            window[0] if window and window[0].position == cursor.position else None
        )
        owned = (
            await self.index.owned_folded_text(resumed.id)
            if resumed is not None
            else None
        )
        return (
            owned is not None
            and cursor.resume_chars <= len(owned)
            and len(owned[: cursor.resume_chars].encode()) == cursor.resume_bytes
        )

    # --- verified snippets ---

    async def _verify_hits(self, hits: list[_Hit]) -> None:
        contents = await self.index.contents_of_hits(
            {hit.chunk.content_id for hit in hits if hit.chunk.content_id}
        )
        events = await self.index.events_of_hits(
            {hit.chunk.event_id for hit in hits if hit.chunk.event_id}
        )
        indexed_digests = {
            hit.chunk.event_id: hit.chunk.source_digest
            for hit in hits
            if hit.chunk.event_id
        }
        current_events = {
            event_id
            for event_id, row in events.items()
            if event_digest(event_segments(row.event)) == indexed_digests[event_id]
        }
        objects: dict[uuid.UUID, tuple[object, list[_Hit]]] = {}
        for hit in hits:
            if hit.chunk.event_id is not None:
                event = events.get(hit.chunk.event_id)
                if event is None:
                    hit.deleted = True
                    continue
                hit.event_id = event.event_id
                if hit.chunk.event_id in current_events:
                    leaf = event_leaf(event.event, hit.chunk.field)
                    if leaf is not None:
                        _snippet_from(hit, leaf.encode())
                continue
            content = contents.get(hit.chunk.content_id)
            if content is None:
                hit.deleted = True
                continue
            hit.event_id = content.event_id
            hit.storage = (content.storage_backend, content.storage_key)
            if not is_search_text(content) or content.sha256 != hit.chunk.source_digest:
                continue
            if content.inline_text is not None:
                _snippet_from(hit, content.inline_text.encode())
            else:
                objects.setdefault(content.id, (content, []))[1].append(hit)
        if objects:
            await self._read_object_snippets(list(objects.values()))
        _withdraw_changed_sources(hits)

    async def _read_object_snippets(self, objects: list[tuple[object, list[_Hit]]]):
        """One stat per object, all settled before any range read; then at
        most OBJECT_READ_CONCURRENCY bounded range reads at a time."""
        limiter = asyncio.Semaphore(OBJECT_READ_CONCURRENCY)

        async def size_of(content) -> int | None:
            store = store_for(content.storage_backend)
            if store is None or content.storage_key is None:
                return None
            async with limiter:
                try:
                    found = await stored(store.stat, content.storage_key)
                except (FileNotFoundError, ValueError, StorageBackendUnavailableError):
                    return None
            return found.size if found is not None else None

        async def read(hit: _Hit, content) -> None:
            bounds = snippet_range(hit.byte_start, hit.byte_end, 0, content.byte_count)
            if bounds is None:
                return
            start, end = bounds
            async with limiter:
                try:
                    data = await stored(
                        store_for(content.storage_backend).read,
                        content.storage_key,
                        start,
                        end - start,
                    )
                except (FileNotFoundError, ValueError, StorageBackendUnavailableError):
                    return
            # A same-size rewrite passes the size check: the hit's own bytes
            # must still be exactly the indexed ones, not merely fold alike.
            if (
                len(data) == end - start
                and data[hit.byte_start - start : hit.byte_end - start] == hit.expected
            ):
                hit.verified(snippet_text(data, start, hit.byte_start, hit.byte_end))

        sizes = await asyncio.gather(*(size_of(content) for content, _ in objects))
        await asyncio.gather(
            *(
                read(hit, content)
                for (content, object_hits), size in zip(objects, sizes, strict=True)
                if size == content.byte_count
                for hit in object_hits
            )
        )

    async def _recheck_objects(self, hits: list[_Hit]) -> None:
        """The content rows read again after storage was awaited: a deleted
        source leaves the page, and a changed one (state, digest, backend or
        key) keeps no snippet."""
        checked = {
            hit.chunk.content_id
            for hit in hits
            if hit.chunk.content_id is not None and not hit.deleted
        }
        current = await self.index.current_objects(checked)
        for hit in hits:
            if hit.chunk.content_id not in checked:
                continue
            row = current.get(hit.chunk.content_id)
            if row is None:
                hit.withdraw()
                hit.deleted = True
            elif (
                row.state != "available"
                or row.coverage not in WITH_BODY
                or row.sha256 != hit.chunk.source_digest
                or (row.storage_backend, row.storage_key) != hit.storage
            ):
                hit.withdraw()

    @staticmethod
    def _item(hit: _Hit) -> SessionSearchHit:
        chunk = hit.chunk
        is_event = chunk.event_id is not None
        return SessionSearchHit(
            source_kind="event" if is_event else "content",
            source_id=chunk.event_id if is_event else chunk.content_id,
            content_id=None if is_event else chunk.content_id,
            event_id=hit.event_id,
            call_key=call_key(chunk.call_anchor) if chunk.call_anchor else None,
            channel=chunk.channel,
            field=chunk.field,
            occurred_at=EPOCH + timedelta(microseconds=chunk.sort_us),
            byte_start=hit.byte_start,
            byte_end=hit.byte_end,
            snippet=hit.snippet,
            snippet_byte_start=hit.snippet_byte_start,
            source_state="available" if hit.available else "unavailable",
        )

    # --- coverage ---

    async def _coverage(
        self, session: AgentSession, hits: list[_Hit]
    ) -> SessionSearchCoverage:
        """Current coverage, read after every await. Sources this response
        could not verify are reclassified by identity, in the same statement
        that counts them, so a source retracted or deleted meanwhile is
        counted once, where it now is."""
        coverage = _Coverage()
        unverified = [hit.chunk for hit in hits if not hit.available]
        for row in await self.index.content_coverage(
            session.id,
            EXTRACTOR_VERSION,
            {chunk.content_id for chunk in unverified if chunk.content_id},
        ):
            _classify(coverage, row)
        events = await self.index.event_coverage(
            session.id,
            EXTRACTOR_VERSION,
            {chunk.event_id for chunk in unverified if chunk.event_id},
        )
        coverage.add(
            "indexed",
            events.indexed - events.unverified,
            events.indexed_bytes - events.unverified_bytes,
            events.indexed - events.unverified,
        )
        coverage.add(
            "unavailable", events.unverified, events.unverified_bytes, events.unverified
        )
        # An event's text size is unknown until it is extracted.
        coverage.add("pending_index", events.stored - events.indexed, 0, 0)
        indexed = coverage.buckets["indexed"]
        pending = coverage.buckets["pending_index"]
        eligible = _Tally(
            indexed.count + pending.count,
            indexed.total + pending.total,
            indexed.unknown or pending.unknown,
        )
        return SessionSearchCoverage(
            **{name: tally.read() for name, tally in coverage.buckets.items()},
            eligible=eligible.read(),
            linked_child_metadata=LinkedChildMetadata(
                count=await self.index.child_count(
                    session.workspace_id, session.owner_id, session.id
                )
            ),
            index_ready=pending.count == 0,
            extractor_version=EXTRACTOR_VERSION,
            verified_at=datetime.now(timezone.utc),
        )


def _live_sets(scope: SearchScope) -> tuple[frozenset[str] | None, ...]:
    """The live call sets a scope filters on: kinds, failures, linked work."""
    return (
        scope.tool_anchors,
        scope.mcp_anchors,
        scope.failed_anchors,
        scope.work_anchors,
    )


def _resumed(chunk: WindowChunk, cursor: SearchCursor | None) -> tuple[int, int]:
    if cursor is not None and chunk.position == cursor.position:
        return cursor.resume_chars, cursor.resume_bytes
    return 0, 0


class _ByteOffsets:
    """Original byte offsets inside one chunk, for occurrences in increasing
    order: each lookup encodes only the text since the previous one."""

    def __init__(self, chunk: MatchingChunk):
        self.chunk = chunk
        self.original = chunk.text.original
        self.char_index = 0
        self.byte_offset = chunk.byte_start

    def _at(self, char_index: int) -> int:
        if char_index < self.char_index:
            return self.chunk.byte_start + len(self.original[:char_index].encode())
        self.byte_offset += len(self.original[self.char_index : char_index].encode())
        self.char_index = char_index
        return self.byte_offset

    def hit(self, folded_start: int, length: int) -> _Hit:
        char_start, char_end = self.chunk.text.original_span(
            folded_start, folded_start + length
        )
        expected = self.original[char_start:char_end].encode()
        byte_start = self._at(char_start)
        return _Hit(self.chunk, byte_start, byte_start + len(expected), expected)


def _snippet_from(hit: _Hit, field_bytes: bytes) -> None:
    """Verify and cut a snippet from a field held in the database."""
    if field_bytes[hit.byte_start : hit.byte_end] != hit.expected:
        return
    bounds = snippet_range(
        hit.byte_start,
        hit.byte_end,
        hit.chunk.segment_byte_start,
        min(hit.chunk.segment_byte_end, len(field_bytes)),
    )
    if bounds is not None:
        start, end = bounds
        hit.verified(
            snippet_text(field_bytes[start:end], start, hit.byte_start, hit.byte_end)
        )


def _withdraw_changed_sources(hits: list[_Hit]) -> None:
    """A source with any unverifiable hit has changed: none of its snippets
    are trusted."""
    changed = {hit.chunk.source_id for hit in hits if not hit.available}
    for hit in hits:
        if hit.chunk.source_id in changed:
            hit.withdraw()


def _classify(coverage: _Coverage, row: ContentCoverageRow) -> None:
    stored_size = (row.count, row.stored_bytes, row.stored_known)
    original_size = (row.count, row.original_bytes, row.original_known)
    if row.state == "pending":
        coverage.add("pending_upload", *stored_size)
    elif row.state == "available" and row.coverage in WITH_BODY:
        coverage.add("available", *stored_size)
        if not row.is_text or row.index_status == "not_text":
            coverage.add("nontext", *stored_size)
        elif row.index_status == "indexed":
            # Indexed, but this response found its bytes changed.
            coverage.add("unavailable" if row.unverified else "indexed", *stored_size)
        elif row.index_status == "unavailable":
            coverage.add("unavailable", *stored_size)
        else:
            coverage.add("pending_index", *stored_size)
    elif row.coverage == "withheld_by_policy":
        coverage.add("withheld", *original_size)
    elif row.coverage in ("collection_failed", "expired"):
        coverage.add("uncaptured", *original_size)
    else:
        coverage.add("unavailable", *original_size)
