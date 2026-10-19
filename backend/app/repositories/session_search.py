# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import (
    and_,
    case,
    delete,
    false,
    func,
    insert,
    or_,
    select,
    tuple_,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import (
    AgentSession,
    AgentSessionContent,
    AgentSessionEvent,
)
from app.models.workspace import WorkspaceMember
from app.models.session_search import (
    SessionSearchChunk,
    SessionSearchSource,
    SessionSearchState,
)
from app.repositories.dialect_insert import conflict_aware_insert
from app.repositories.session_calls import (
    CODEX_HARNESSES,
    CODEX_RESULT_MARKER,
    PROMPT_ACTION,
    anchor_of_event,
    event_failed,
    is_timeline_event,
)
from app.schemas.session_content import TEXT_MEDIA_TYPES, WITH_BODY
from app.services.session_search_text import FoldedText, TextChunk

Chunk = SessionSearchChunk
Source = SessionSearchSource
Content = AgentSessionContent
Event = AgentSessionEvent

# (sort_us, sort_order, source_id, ordinal): where a chronological scan stands.
ScanPosition = tuple[int, int, uuid.UUID, int]


@dataclass(frozen=True)
class SearchScope:
    """Which indexed chunks a query may scan. `None` sets mean the dimension
    is not filtered; an empty set matches nothing."""

    extractor_version: str
    channels: frozenset[str] | None = None
    tool_alias: bool = False
    tool_anchors: frozenset[str] | None = None
    mcp_anchors: frozenset[str] | None = None
    failed_anchors: frozenset[str] | None = None
    work_anchors: frozenset[str] | None = None


@dataclass(frozen=True)
class SourceRecord:
    """A source's index row values and chunks, ready to write."""

    values: dict
    chunks: list[TextChunk]
    sort_us: int
    sort_order: int

    @property
    def digest(self) -> str:
        return self.values["source_digest"]


@dataclass(frozen=True)
class WindowChunk:
    id: uuid.UUID
    position: ScanPosition
    owned_bytes: int


@dataclass(frozen=True)
class MatchingChunk:
    id: uuid.UUID
    source_id: uuid.UUID
    content_id: uuid.UUID | None
    event_id: uuid.UUID | None
    call_anchor: str | None
    source_digest: str
    field: str
    channel: str | None
    segment_byte_start: int
    segment_byte_end: int
    byte_start: int
    owned_chars: int
    sort_us: int
    text: FoldedText


@dataclass(frozen=True)
class ContentCoverageRow:
    state: str
    coverage: str
    is_text: bool
    index_status: str | None
    # Rows of sources the caller could not verify just now.
    unverified: bool
    count: int
    stored_bytes: int
    stored_known: int
    original_bytes: int
    original_known: int


@dataclass(frozen=True)
class EventCoverage:
    stored: int
    indexed: int
    indexed_bytes: int
    # Of the indexed, those the caller could not verify just now.
    unverified: int
    unverified_bytes: int


@dataclass(frozen=True)
class ObjectDescriptor:
    """A content row's identity and body facts, detached from any session."""

    content_id: uuid.UUID
    session_id: uuid.UUID
    workspace_id: uuid.UUID
    owner_id: uuid.UUID
    installation_id: uuid.UUID
    state: str
    coverage: str
    media_type: str
    channel: str
    sha256: str | None
    byte_count: int | None
    storage_backend: str | None
    storage_key: str | None
    inline_text: str | None


def encode_case_map(text: FoldedText) -> str | None:
    if not text.case_positions:
        return None
    deltas, previous = [], 0
    for position in text.case_positions:
        deltas.append(position - previous)
        previous = position
    return json.dumps({"d": deltas, "c": text.case_characters})


def decode_case_map(folded: str, case_map: str | None) -> FoldedText:
    if case_map is None:
        return FoldedText(folded, (), "")
    decoded = json.loads(case_map)
    positions, position = [], 0
    for delta in decoded["d"]:
        position += delta
        positions.append(position)
    return FoldedText(folded, tuple(positions), decoded["c"])


def _chunk_rows(source_id: uuid.UUID, record: SourceRecord) -> list[dict]:
    return [
        {
            "id": uuid.uuid4(),
            "session_id": record.values["session_id"],
            "source_id": source_id,
            "sort_us": record.sort_us,
            "sort_order": record.sort_order,
            "ordinal": chunk.ordinal,
            "field": chunk.field,
            "channel": chunk.channel,
            "segment_byte_start": chunk.segment_byte_start,
            "segment_byte_end": chunk.segment_byte_end,
            "byte_start": chunk.byte_start,
            "owned_chars": chunk.owned_chars,
            "owned_bytes": chunk.owned_bytes,
            "folded_text": chunk.text.folded,
            "case_map": encode_case_map(chunk.text),
        }
        for chunk in record.chunks
    ]


class SessionSearchRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    def _dialect(self) -> str:
        return self.db.get_bind().dialect.name

    # --- sources, read and locked in the order session then source row ---

    async def lock_session(self, session_id: uuid.UUID) -> AgentSession | None:
        return await self.db.scalar(
            select(AgentSession)
            .where(AgentSession.id == session_id)
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )

    async def session_of_content(self, content_id: uuid.UUID) -> uuid.UUID | None:
        return await self.db.scalar(
            select(Content.session_id).where(Content.id == content_id)
        )

    async def session_of_event(self, event_id: uuid.UUID) -> uuid.UUID | None:
        return await self.db.scalar(
            select(Event.session_id).where(Event.id == event_id)
        )

    async def lock_content(self, content_id: uuid.UUID) -> AgentSessionContent | None:
        return await self.db.scalar(
            select(Content)
            .where(Content.id == content_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    async def event(self, event_id: uuid.UUID) -> AgentSessionEvent | None:
        return await self.db.scalar(
            select(Event)
            .where(Event.id == event_id)
            .execution_options(populate_existing=True)
        )

    async def object_descriptor(self, content_id: uuid.UUID) -> ObjectDescriptor | None:
        row = (
            await self.db.execute(
                select(
                    Content.id,
                    Content.session_id,
                    Content.workspace_id,
                    Content.owner_id,
                    Content.installation_id,
                    Content.state,
                    Content.coverage,
                    Content.media_type,
                    Content.channel,
                    Content.sha256,
                    Content.byte_count,
                    Content.storage_backend,
                    Content.storage_key,
                    Content.inline_text,
                ).where(Content.id == content_id)
            )
        ).one_or_none()
        return ObjectDescriptor(*row) if row is not None else None

    async def source_of_content(
        self, content_id: uuid.UUID
    ) -> SessionSearchSource | None:
        return await self.db.scalar(
            select(Source)
            .where(Source.content_id == content_id)
            .execution_options(populate_existing=True)
        )

    async def source_of_event(self, event_id: uuid.UUID) -> SessionSearchSource | None:
        return await self.db.scalar(
            select(Source)
            .where(Source.event_id == event_id)
            .execution_options(populate_existing=True)
        )

    async def sources_of_events(
        self, event_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, SessionSearchSource]:
        if not event_ids:
            return {}
        rows = await self.db.scalars(
            select(Source)
            .where(Source.event_id.in_(event_ids))
            .execution_options(populate_existing=True)
        )
        return {row.event_id: row for row in rows}

    async def is_member(self, workspace_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        found = await self.db.scalar(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user_id,
            )
        )
        return found is not None

    async def insert_sources(self, records: list[SourceRecord]) -> None:
        """Rows for sources that have none yet, and their chunks."""
        sources, chunks = [], []
        for record in records:
            source_id = uuid.uuid4()
            sources.append({"id": source_id, **record.values})
            chunks.extend(_chunk_rows(source_id, record))
        await self.db.execute(insert(Source), sources)
        if chunks:
            await self.db.execute(insert(Chunk), chunks)

    async def replace_source(
        self, existing: SessionSearchSource | None, record: SourceRecord
    ) -> None:
        if existing is None:
            await self.insert_sources([record])
            return
        await self.db.execute(
            delete(Chunk)
            .where(Chunk.source_id == existing.id)
            .execution_options(synchronize_session=False)
        )
        for key, value in record.values.items():
            setattr(existing, key, value)
        await self.db.flush()
        rows = _chunk_rows(existing.id, record)
        if rows:
            await self.db.execute(insert(Chunk), rows)

    async def mark_content_pending(self, values: dict) -> None:
        """A content source awaiting its object read, replacing any row the
        content had."""
        content_id = values["content_id"]
        await self.db.execute(
            delete(Chunk)
            .where(
                Chunk.source_id.in_(
                    select(Source.id).where(Source.content_id == content_id)
                )
            )
            .execution_options(synchronize_session=False)
        )
        statement = conflict_aware_insert(self.db, Source).values(
            id=uuid.uuid4(), **values
        )
        await self.db.execute(
            statement.on_conflict_do_update(
                index_elements=["content_id"],
                set_={key: statement.excluded[key] for key in values},
            )
        )

    async def bump_generation(self, session_id: uuid.UUID, now: datetime) -> None:
        statement = conflict_aware_insert(self.db, SessionSearchState).values(
            session_id=session_id, generation=1, updated_at=now
        )
        await self.db.execute(
            statement.on_conflict_do_update(
                index_elements=["session_id"],
                set_={
                    "generation": SessionSearchState.generation + 1,
                    "updated_at": now,
                },
            )
        )

    # --- queries; never locking, so a writer's open transaction never blocks
    # a reader, which sees the last committed generation ---

    async def generation(self, session_id: uuid.UUID) -> int:
        found = await self.db.scalar(
            select(SessionSearchState.generation).where(
                SessionSearchState.session_id == session_id
            )
        )
        return found or 0

    def _scope(self, session_id: uuid.UUID, scope: SearchScope):
        readable_content = and_(
            Content.state == "available",
            Content.coverage.in_(WITH_BODY),
            Content.media_type.in_(TEXT_MEDIA_TYPES),
            Content.sha256 == Source.source_digest,
        )
        conditions = [
            Chunk.session_id == session_id,
            Source.status == "indexed",
            Source.extractor_version == scope.extractor_version,
            or_(Source.event_id.is_not(None), readable_content),
        ]
        if scope.channels is not None:
            choices = [Chunk.channel.in_(scope.channels)] if scope.channels else []
            if scope.tool_alias:
                choices.append(
                    and_(
                        Source.content_id.is_not(None),
                        Chunk.channel.in_(("tool_input", "tool_output")),
                    )
                )
            if scope.tool_anchors is not None:
                choices.append(Source.call_anchor.in_(scope.tool_anchors))
            if scope.mcp_anchors is not None:
                choices.append(Source.call_anchor.in_(scope.mcp_anchors))
            conditions.append(or_(*choices) if choices else false())
        if scope.failed_anchors is not None:
            conditions.append(Source.call_anchor.in_(scope.failed_anchors))
        if scope.work_anchors is not None:
            conditions.append(Source.call_anchor.in_(scope.work_anchors))
        return conditions

    def _scanned(self, columns, session_id, scope):
        return (
            select(*columns)
            .select_from(Chunk)
            .join(Source, Source.id == Chunk.source_id)
            .outerjoin(Content, Content.id == Source.content_id)
            .where(*self._scope(session_id, scope))
        )

    async def eligible_totals(
        self, session_id: uuid.UUID, scope: SearchScope
    ) -> tuple[int, int]:
        """(sources, folded bytes) a complete scan of this scope reads."""
        row = (
            await self.db.execute(
                self._scanned(
                    (
                        func.count(func.distinct(Chunk.source_id)),
                        func.coalesce(func.sum(Chunk.owned_bytes), 0),
                    ),
                    session_id,
                    scope,
                )
            )
        ).one()
        return int(row[0]), int(row[1])

    async def scan_window(
        self,
        session_id: uuid.UUID,
        scope: SearchScope,
        start: ScanPosition | None,
        limit: int,
    ) -> list[WindowChunk]:
        position = tuple_(
            Chunk.sort_us, Chunk.sort_order, Chunk.source_id, Chunk.ordinal
        )
        query = self._scanned(
            (
                Chunk.id,
                Chunk.sort_us,
                Chunk.sort_order,
                Chunk.source_id,
                Chunk.ordinal,
                Chunk.owned_bytes,
            ),
            session_id,
            scope,
        )
        if start is not None:
            query = query.where(position >= start)
        rows = await self.db.execute(
            query.order_by(
                Chunk.sort_us, Chunk.sort_order, Chunk.source_id, Chunk.ordinal
            ).limit(limit)
        )
        return [
            WindowChunk(
                id=row.id,
                position=(row.sort_us, row.sort_order, row.source_id, row.ordinal),
                owned_bytes=row.owned_bytes,
            )
            for row in rows
        ]

    async def owned_folded_text(self, chunk_id: uuid.UUID) -> str | None:
        """The folded text a chunk owns, for a chunk found in a scoped window."""
        row = (
            await self.db.execute(
                select(Chunk.folded_text, Chunk.owned_chars).where(Chunk.id == chunk_id)
            )
        ).one_or_none()
        return row.folded_text[: row.owned_chars] if row is not None else None

    async def matching_chunks(
        self, chunk_ids: list[uuid.UUID], folded_query: str
    ) -> dict[uuid.UUID, MatchingChunk]:
        """The chunks among `chunk_ids` whose text contains the folded query
        anywhere, overlap included; only those carry their text back."""
        if not chunk_ids:
            return {}
        # Plain substring position: no pattern characters, so `%`, `_` and
        # backslashes in a query are literal.
        contains = (
            func.strpos(Chunk.folded_text, folded_query)
            if self._dialect() == "postgresql"
            else func.instr(Chunk.folded_text, folded_query)
        )
        rows = await self.db.execute(
            select(
                Chunk.id,
                Chunk.source_id,
                Source.content_id,
                Source.event_id,
                Source.call_anchor,
                Source.source_digest,
                Chunk.field,
                Chunk.channel,
                Chunk.segment_byte_start,
                Chunk.segment_byte_end,
                Chunk.byte_start,
                Chunk.owned_chars,
                Chunk.sort_us,
                Chunk.folded_text,
                Chunk.case_map,
            )
            .join(Source, Source.id == Chunk.source_id)
            .where(Chunk.id.in_(chunk_ids), contains > 0)
        )
        return {
            row.id: MatchingChunk(
                id=row.id,
                source_id=row.source_id,
                content_id=row.content_id,
                event_id=row.event_id,
                call_anchor=row.call_anchor,
                source_digest=row.source_digest,
                field=row.field,
                channel=row.channel,
                segment_byte_start=row.segment_byte_start,
                segment_byte_end=row.segment_byte_end,
                byte_start=row.byte_start,
                owned_chars=row.owned_chars,
                sort_us=row.sort_us,
                text=decode_case_map(row.folded_text, row.case_map),
            )
            for row in rows
        }

    # --- live call semantics, as the calls API evaluates them ---

    async def failed_anchors(self, session_id: uuid.UUID) -> frozenset[str]:
        failed = event_failed(self._dialect(), session_id)
        rows = await self.db.scalars(
            select(anchor_of_event)
            .where(Event.session_id == session_id, is_timeline_event)
            .group_by(anchor_of_event)
            .having(func.max(case((failed, 1), else_=0)) == 1)
        )
        return frozenset(rows)

    async def call_kinds(self, session_id: uuid.UUID) -> dict[str, str]:
        """Each timeline entry's kind as the calls API names it."""
        legacy = Event.__table__.alias("legacy_mcp")
        payload = legacy.c.event
        native_server = payload[("raw", "attributes", "mcp_server")].as_string()
        # Mirrors app.core.codex_tool_result: older Codex rows name their MCP
        # server only inside the retained native result.
        legacy_mcp_ids = select(legacy.c.id).where(
            legacy.c.session_id == session_id,
            payload[("harness", "name")].as_string().in_(CODEX_HARNESSES),
            payload[("raw", "attributes", "event.name")].as_string()
            == CODEX_RESULT_MARKER,
            native_server.is_not(None),
            native_server != "",
        )
        names_mcp = or_(
            Event.mcp_tool.is_not(None),
            Event.mcp_server.is_not(None),
            Event.id.in_(legacy_mcp_ids),
        )
        rows = await self.db.execute(
            select(
                anchor_of_event.label("anchor"),
                func.max(case((Event.action == PROMPT_ACTION, 1), else_=0)).label(
                    "prompt"
                ),
                func.max(case((names_mcp, 1), else_=0)).label("mcp"),
            )
            .where(Event.session_id == session_id, is_timeline_event)
            .group_by(anchor_of_event)
        )
        return {
            row.anchor: "prompt" if row.prompt else "mcp" if row.mcp else "tool"
            for row in rows
        }

    # --- hits ---

    async def contents_of_hits(self, content_ids: set[uuid.UUID]) -> dict:
        if not content_ids:
            return {}
        rows = await self.db.execute(
            select(
                Content.id,
                Content.session_id,
                Content.event_id,
                Content.call_key,
                Content.channel,
                Content.state,
                Content.coverage,
                Content.media_type,
                Content.sha256,
                Content.byte_count,
                Content.storage_backend,
                Content.storage_key,
                Content.inline_text,
                Content.occurred_at,
            ).where(Content.id.in_(content_ids))
        )
        return {row.id: row for row in rows}

    async def events_of_hits(self, event_ids: set[uuid.UUID]) -> dict:
        if not event_ids:
            return {}
        rows = await self.db.execute(
            select(
                Event.id,
                Event.session_id,
                Event.event_id,
                Event.native_tool_call_id,
                Event.occurred_at,
                Event.event,
            ).where(Event.id.in_(event_ids))
        )
        return {row.id: row for row in rows}

    async def current_objects(self, content_ids: set[uuid.UUID]) -> dict:
        """The body facts a returned object snippet depends on, read again."""
        if not content_ids:
            return {}
        rows = await self.db.execute(
            select(
                Content.id,
                Content.state,
                Content.coverage,
                Content.sha256,
                Content.storage_backend,
                Content.storage_key,
            ).where(Content.id.in_(content_ids))
        )
        return {row.id: row for row in rows}

    # --- coverage ---

    async def content_coverage(
        self,
        session_id: uuid.UUID,
        extractor_version: str,
        unverified: set[uuid.UUID],
    ) -> list[ContentCoverageRow]:
        current = and_(
            Source.content_id == Content.id,
            Source.extractor_version == extractor_version,
            Source.source_digest == Content.sha256,
        )
        original = func.coalesce(Content.original_byte_count, Content.byte_count)
        # Grouped through subquery columns: the expressions carry bind
        # parameters, which PostgreSQL would not match in a GROUP BY.
        classified = (
            select(
                Content.state.label("state"),
                Content.coverage.label("coverage"),
                case((Content.media_type.in_(TEXT_MEDIA_TYPES), 1), else_=0).label(
                    "is_text"
                ),
                Source.status.label("index_status"),
                case((Content.id.in_(unverified), 1), else_=0).label("unverified"),
                Content.byte_count.label("stored_bytes"),
                original.label("original_bytes"),
            )
            .select_from(Content)
            .outerjoin(Source, current)
            .where(Content.session_id == session_id)
            .subquery()
        )
        rows = await self.db.execute(
            select(
                classified.c.state,
                classified.c.coverage,
                classified.c.is_text,
                classified.c.index_status,
                classified.c.unverified,
                func.count(),
                func.coalesce(func.sum(classified.c.stored_bytes), 0),
                func.count(classified.c.stored_bytes),
                func.coalesce(func.sum(classified.c.original_bytes), 0),
                func.count(classified.c.original_bytes),
            ).group_by(
                classified.c.state,
                classified.c.coverage,
                classified.c.is_text,
                classified.c.index_status,
                classified.c.unverified,
            )
        )
        return [
            ContentCoverageRow(
                state=row[0],
                coverage=row[1],
                is_text=bool(row[2]),
                index_status=row[3],
                unverified=bool(row[4]),
                count=int(row[5]),
                stored_bytes=int(row[6]),
                stored_known=int(row[7]),
                original_bytes=int(row[8]),
                original_known=int(row[9]),
            )
            for row in rows
        ]

    async def event_coverage(
        self,
        session_id: uuid.UUID,
        extractor_version: str,
        unverified: set[uuid.UUID],
    ) -> EventCoverage:
        """Stored events against the current extractor's rows, in one
        statement with the unverified ones among them."""
        is_unverified = and_(Source.id.is_not(None), Event.id.in_(unverified))
        row = (
            await self.db.execute(
                select(
                    func.count(Event.id),
                    func.count(Source.id),
                    func.coalesce(func.sum(Source.byte_count), 0),
                    func.coalesce(func.sum(case((is_unverified, 1), else_=0)), 0),
                    func.coalesce(
                        func.sum(case((is_unverified, Source.byte_count), else_=0)), 0
                    ),
                )
                .select_from(Event)
                .outerjoin(
                    Source,
                    and_(
                        Source.event_id == Event.id,
                        Source.status == "indexed",
                        Source.extractor_version == extractor_version,
                    ),
                )
                .where(Event.session_id == session_id)
            )
        ).one()
        return EventCoverage(*(int(value) for value in row))

    async def child_count(
        self, workspace_id: uuid.UUID, owner_id: uuid.UUID, session_id: uuid.UUID
    ) -> int:
        return int(
            await self.db.scalar(
                select(func.count())
                .select_from(AgentSession)
                .where(
                    AgentSession.workspace_id == workspace_id,
                    AgentSession.owner_id == owner_id,
                    AgentSession.parent_session_id == session_id,
                )
            )
            or 0
        )
