# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Integer,
    LargeBinary,
    String,
    Text,
    and_,
    case,
    cast,
    delete,
    exists,
    func,
    inspect,
    literal_column,
    null,
    or_,
    select,
    union_all,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.time import as_utc
from app.models.agent_session import (
    AgentSession,
    AgentSessionContent,
    AgentSessionEvent,
)
from app.models.session_search import SessionSearchSource
from app.models.session_search_backfill import (
    SessionSearchBackfillClaim,
    SessionSearchBackfillRun,
)
from app.models.workspace import WorkspaceMember
from app.repositories.dialect_insert import conflict_aware_insert
from app.repositories.session_search import ContentCoverageRow
from app.schemas.session_content import TEXT_MEDIA_TYPES, WITH_BODY

Run = SessionSearchBackfillRun
Claim = SessionSearchBackfillClaim
Content = AgentSessionContent
Event = AgentSessionEvent
Source = SessionSearchSource

# A source row that a scan reads, or that records why its exact body cannot be.
SETTLED_INDEX_STATUSES = ("indexed", "unavailable", "not_text")


@dataclass(frozen=True)
class ContentCandidate:
    """A content row's metadata as discovery sees it: never its body."""

    id: uuid.UUID
    member: bool
    state: str
    coverage: str
    media_type: str
    sha256: str | None
    byte_count: int | None
    storage_backend: str | None
    has_storage_key: bool
    inline: bool
    # Persisted UTF-8 bytes of an inline body, measured by the database.
    inline_bytes: int | None
    index_status: str | None
    index_version: str | None
    index_digest: str | None


@dataclass(frozen=True)
class EventCandidate:
    id: uuid.UUID
    member: bool
    index_status: str | None
    index_version: str | None


@dataclass(frozen=True)
class ScopeAggregate:
    contents: list[ContentCoverageRow]
    events_stored: int
    events_indexed: int
    events_indexed_bytes: int
    owner_not_member: int
    child_sessions: int
    unresolved_metadata: int


def _owner_is_member():
    """Whether the correlated session's owner is still a member of its
    workspace: the session search's own authorization."""
    return (
        exists()
        .where(
            WorkspaceMember.workspace_id == AgentSession.workspace_id,
            WorkspaceMember.user_id == AgentSession.owner_id,
        )
        .correlate(AgentSession)
    )


def _retained_text():
    return and_(
        Content.state == "available",
        Content.coverage.in_(WITH_BODY),
        Content.media_type.in_(TEXT_MEDIA_TYPES),
    )


class SessionSearchBackfillRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    def _dialect(self) -> str:
        return self.db.get_bind().dialect.name

    def _utf8_bytes(self, column, *, json: bool = False):
        if self._dialect() == "postgresql":
            return func.octet_length(cast(column, Text) if json else column)
        return func.length(cast(column, LargeBinary))

    def _trusted_metadata(self, backend: str, max_body_bytes: int):
        """Retained text whose digest and size the backfill can rely on: an
        inline body whose declared size is its actual size, or an object of
        the effective store with a known, accepted size."""
        return and_(
            Content.sha256.is_not(None),
            or_(
                and_(
                    Content.inline_text.is_not(None),
                    Content.byte_count == self._utf8_bytes(Content.inline_text),
                ),
                and_(
                    Content.inline_text.is_(None),
                    Content.byte_count.is_not(None),
                    Content.byte_count <= max_body_bytes,
                    Content.storage_backend == backend,
                    Content.storage_key.is_not(None),
                ),
            ),
        )

    def _untrusted_metadata(self, backend: str, max_body_bytes: int):
        """The complement of `_trusted_metadata` among retained text, spelled
        out so that a NULL never hides a row from it."""
        return or_(
            Content.sha256.is_(None),
            and_(
                Content.inline_text.is_not(None),
                or_(
                    Content.byte_count.is_(None),
                    Content.byte_count != self._utf8_bytes(Content.inline_text),
                ),
            ),
            and_(
                Content.inline_text.is_(None),
                or_(
                    Content.byte_count.is_(None),
                    Content.byte_count > max_body_bytes,
                    Content.storage_backend.is_distinct_from(backend),
                    Content.storage_key.is_(None),
                ),
            ),
        )

    async def clock(self) -> datetime:
        # clock_timestamp() is wall time; now() is fixed at transaction start,
        # so a transaction that waited on a lock would judge an expired lease
        # by the moment it began.
        if self._dialect() == "postgresql":
            expression = func.clock_timestamp(type_=DateTime(timezone=True))
        else:
            expression = func.current_timestamp()
        return as_utc(await self.db.scalar(select(expression)))

    async def tables_present(self) -> bool:
        connection = await self.db.connection()
        return await connection.run_sync(
            lambda sync: all(
                inspect(sync).has_table(table.name)
                for table in (Run.__table__, Claim.__table__)
            )
        )

    # --- runs; locked last, after any session, content or claim row ---

    async def run(self, run_id: uuid.UUID) -> Run | None:
        return await self.db.scalar(
            select(Run)
            .where(Run.id == run_id)
            .execution_options(populate_existing=True)
        )

    async def lock_run(self, run_id: uuid.UUID) -> Run | None:
        return await self.db.scalar(
            select(Run)
            .where(Run.id == run_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    async def lock_lane_head(self, lane: str) -> Run | None:
        """The lane's newest run: the only one no later run superseded."""
        return await self.db.scalar(
            select(Run)
            .where(Run.lane == lane, Run.superseded_by.is_(None))
            .order_by(Run.created_at.desc(), Run.id.desc())
            .limit(1)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    async def predecessor_id(self, run_id: uuid.UUID) -> uuid.UUID | None:
        return await self.db.scalar(select(Run.id).where(Run.superseded_by == run_id))

    async def add_run(self, **values) -> Run:
        run = Run(**values)
        self.db.add(run)
        await self.db.flush()
        await self.db.refresh(run)
        return run

    # --- claims ---

    async def claims(self, run_id: uuid.UUID) -> list[Claim]:
        rows = await self.db.scalars(
            select(Claim)
            .where(Claim.run_id == run_id)
            .order_by(Claim.source_kind, Claim.source_id)
            .execution_options(populate_existing=True)
        )
        return list(rows)

    async def lock_claim(
        self, run_id: uuid.UUID, source_kind: str, source_id: uuid.UUID
    ) -> Claim | None:
        return await self.db.scalar(
            select(Claim)
            .where(
                Claim.run_id == run_id,
                Claim.source_kind == source_kind,
                Claim.source_id == source_id,
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    async def insert_claims(self, rows: list[dict]) -> None:
        statement = conflict_aware_insert(self.db, Claim).values(rows)
        await self.db.execute(
            statement.on_conflict_do_nothing(
                index_elements=["run_id", "source_kind", "source_id"]
            )
        )

    async def delete_claim(
        self, run_id: uuid.UUID, source_kind: str, source_id: uuid.UUID
    ) -> None:
        await self.db.execute(
            delete(Claim)
            .where(
                Claim.run_id == run_id,
                Claim.source_kind == source_kind,
                Claim.source_id == source_id,
            )
            .execution_options(synchronize_session=False)
        )

    async def delete_claims(self, run_id: uuid.UUID) -> None:
        """A finished run's claims: at most 25 rows by construction."""
        await self.db.execute(
            delete(Claim)
            .where(Claim.run_id == run_id)
            .execution_options(synchronize_session=False)
        )

    # --- finite scans, in UUID order, metadata only ---

    async def last_content_id(self) -> uuid.UUID | None:
        return await self.db.scalar(
            select(Content.id).order_by(Content.id.desc()).limit(1)
        )

    async def last_event_id(self) -> uuid.UUID | None:
        return await self.db.scalar(select(Event.id).order_by(Event.id.desc()).limit(1))

    async def content_candidates(
        self,
        *,
        after: uuid.UUID | None,
        upper: uuid.UUID,
        limit: int,
        recorded_unavailable_in: str | None = None,
    ) -> list[ContentCandidate]:
        """The next `limit` content rows by id, whatever their state, so the
        bound holds before any membership or index filtering. Verification
        narrows the joined index facts, never the candidate content keys."""
        index_match = and_(
            Source.content_id == Content.id,
            Source.content_id <= upper,
        )
        if after is not None:
            index_match = and_(index_match, Source.content_id > after)
        if recorded_unavailable_in is not None:
            index_match = and_(
                index_match,
                Source.status == "unavailable",
                Source.extractor_version == recorded_unavailable_in,
                Source.source_digest == Content.sha256,
            )
        query = (
            select(
                Content.id,
                _owner_is_member().label("member"),
                Content.state,
                Content.coverage,
                Content.media_type,
                Content.sha256,
                Content.byte_count,
                Content.storage_backend,
                Content.storage_key.is_not(None).label("has_storage_key"),
                Content.inline_text.is_not(None).label("inline"),
                self._utf8_bytes(Content.inline_text).label("inline_bytes"),
                Source.status.label("index_status"),
                Source.extractor_version.label("index_version"),
                Source.source_digest.label("index_digest"),
            )
            .join(AgentSession, AgentSession.id == Content.session_id)
            .outerjoin(Source, index_match)
            .where(Content.id <= upper)
            .order_by(Content.id)
            .limit(limit)
        )
        if after is not None:
            query = query.where(Content.id > after)
        rows = await self.db.execute(query)
        return [
            ContentCandidate(
                id=row.id,
                member=bool(row.member),
                state=row.state,
                coverage=row.coverage,
                media_type=row.media_type,
                sha256=row.sha256,
                byte_count=row.byte_count,
                storage_backend=row.storage_backend,
                has_storage_key=bool(row.has_storage_key),
                inline=bool(row.inline),
                inline_bytes=row.inline_bytes,
                index_status=row.index_status,
                index_version=row.index_version,
                index_digest=row.index_digest,
            )
            for row in rows
        ]

    async def event_candidates(
        self, *, after: uuid.UUID | None, upper: uuid.UUID, limit: int
    ) -> list[EventCandidate]:
        index_match = and_(
            Source.event_id == Event.id,
            Source.event_id <= upper,
        )
        if after is not None:
            index_match = and_(index_match, Source.event_id > after)
        query = (
            select(
                Event.id,
                _owner_is_member().label("member"),
                Source.status.label("index_status"),
                Source.extractor_version.label("index_version"),
            )
            .join(AgentSession, AgentSession.id == Event.session_id)
            .outerjoin(Source, index_match)
            .where(Event.id <= upper)
            .order_by(Event.id)
            .limit(limit)
        )
        if after is not None:
            query = query.where(Event.id > after)
        rows = await self.db.execute(query)
        return [
            EventCandidate(
                id=row.id,
                member=bool(row.member),
                index_status=row.index_status,
                index_version=row.index_version,
            )
            for row in rows
        ]

    async def content_facts(self, content_id: uuid.UUID) -> ContentCandidate | None:
        """One content row's metadata and its owner's membership now."""
        row = (
            await self.db.execute(
                select(
                    Content.id,
                    _owner_is_member().label("member"),
                    Content.state,
                    Content.coverage,
                    Content.media_type,
                    Content.sha256,
                    Content.byte_count,
                    Content.storage_backend,
                    Content.storage_key.is_not(None).label("has_storage_key"),
                    Content.inline_text.is_not(None).label("inline"),
                    self._utf8_bytes(Content.inline_text).label("inline_bytes"),
                )
                .join(AgentSession, AgentSession.id == Content.session_id)
                .where(Content.id == content_id)
            )
        ).one_or_none()
        if row is None:
            return None
        return ContentCandidate(
            id=row.id,
            member=bool(row.member),
            state=row.state,
            coverage=row.coverage,
            media_type=row.media_type,
            sha256=row.sha256,
            byte_count=row.byte_count,
            storage_backend=row.storage_backend,
            has_storage_key=bool(row.has_storage_key),
            inline=bool(row.inline),
            inline_bytes=row.inline_bytes,
            index_status=None,
            index_version=None,
            index_digest=None,
        )

    async def lock_content_metadata(self, content_id: uuid.UUID) -> uuid.UUID | None:
        """Lock a content row without reading its body."""
        return await self.db.scalar(
            select(Content.id).where(Content.id == content_id).with_for_update()
        )

    async def stored_bytes(self, source_kind: str, source_id: uuid.UUID) -> int | None:
        """An inline body's or an event's persisted UTF-8 bytes, measured in the
        database without reading it."""
        if source_kind == "event":
            query = select(self._utf8_bytes(Event.event, json=True)).where(
                Event.id == source_id
            )
        else:
            query = select(self._utf8_bytes(Content.inline_text)).where(
                Content.id == source_id
            )
        return await self.db.scalar(query)

    async def has_unclaimed_content(
        self,
        *,
        extractor_version: str,
        claimed: set[uuid.UUID],
        backend: str,
        max_body_bytes: int,
    ) -> bool:
        """Whether an authorized retained text body that the backfill could
        process is still not settled for this extractor and digest, and no
        claim holds it. Rows whose metadata cannot be trusted are left to
        coverage, which counts them as unresolved."""
        settled = exists().where(
            Source.content_id == Content.id,
            Source.extractor_version == extractor_version,
            Source.source_digest == Content.sha256,
            Source.status.in_(SETTLED_INDEX_STATUSES),
        )
        query = (
            select(Content.id)
            .join(AgentSession, AgentSession.id == Content.session_id)
            .where(
                _owner_is_member(),
                _retained_text(),
                self._trusted_metadata(backend, max_body_bytes),
                ~settled,
            )
            .limit(1)
        )
        if claimed:
            query = query.where(Content.id.not_in(list(claimed)))
        return await self.db.scalar(query) is not None

    async def has_unclaimed_event(
        self, *, extractor_version: str, claimed: set[uuid.UUID]
    ) -> bool:
        indexed = exists().where(
            Source.event_id == Event.id,
            Source.extractor_version == extractor_version,
            Source.status == "indexed",
        )
        query = (
            select(Event.id)
            .join(AgentSession, AgentSession.id == Event.session_id)
            .where(_owner_is_member(), ~indexed)
            .limit(1)
        )
        if claimed:
            query = query.where(Event.id.not_in(list(claimed)))
        return await self.db.scalar(query) is not None

    # --- coverage: one aggregate statement for the whole scope ---

    async def scope_aggregate(
        self, *, extractor_version: str, backend: str, max_body_bytes: int
    ) -> ScopeAggregate:
        """Retained sources of current members in the session search's own
        coverage grouping, plus their retained text with untrusted metadata,
        and non-member and child-session counts, in one statement with a
        bounded result. Query count is constant; database scan work grows
        with the retained metadata corpus and needs separate measurement."""
        member = _owner_is_member()
        current_source = and_(
            Source.content_id == Content.id,
            Source.extractor_version == extractor_version,
            Source.source_digest == Content.sha256,
        )
        current_status = (
            select(Source.status)
            .where(current_source)
            .correlate(Content)
            .scalar_subquery()
        )

        def classify_content(index_status):
            return (
                select(
                    Content.state.label("state"),
                    Content.coverage.label("coverage"),
                    case((Content.media_type.in_(TEXT_MEDIA_TYPES), 1), else_=0).label(
                        "is_text"
                    ),
                    index_status.label("index_status"),
                    Content.byte_count.label("stored_bytes"),
                    func.coalesce(
                        Content.original_byte_count, Content.byte_count
                    ).label("original_bytes"),
                )
                .select_from(Content)
                .join(AgentSession, AgentSession.id == Content.session_id)
                .where(member)
            )

        classified = classify_content(current_status)
        if self._dialect() == "postgresql":
            # Keep SERIALIZABLE's narrow source reads. Gate at execution so
            # reused prepared plans follow the current transaction's isolation.
            serializable = (
                func.current_setting("transaction_isolation") == "serializable"
            )
            classified = union_all(
                classified.where(serializable),
                classify_content(Source.status)
                .outerjoin(Source, current_source)
                .where(~serializable),
            )
        # Grouped through subquery columns: the expressions carry bind
        # parameters, which PostgreSQL would not match in a GROUP BY.
        classified = classified.subquery()
        no_text = cast(null(), String)
        no_number = cast(null(), Integer)
        zero = literal_column("0", BigInteger)

        def part(name: str):
            return literal_column(f"'{name}'", String).label("part")

        contents = select(
            part("content"),
            classified.c.state,
            classified.c.coverage,
            classified.c.is_text,
            classified.c.index_status,
            func.count().label("items"),
            func.coalesce(func.sum(classified.c.stored_bytes), 0).label("stored"),
            func.count(classified.c.stored_bytes).label("stored_known"),
            func.coalesce(func.sum(classified.c.original_bytes), 0).label("original"),
            func.count(classified.c.original_bytes).label("original_known"),
        ).group_by(
            classified.c.state,
            classified.c.coverage,
            classified.c.is_text,
            classified.c.index_status,
        )
        indexed_event = and_(
            Source.event_id == Event.id,
            Source.status == "indexed",
            Source.extractor_version == extractor_version,
        )
        events = (
            select(
                part("event"),
                no_text,
                no_text,
                no_number,
                no_text,
                func.count(Event.id),
                func.coalesce(func.sum(Source.byte_count), 0),
                func.count(Source.id),
                zero,
                zero,
            )
            .select_from(Event)
            .join(AgentSession, AgentSession.id == Event.session_id)
            .outerjoin(Source, indexed_event)
            .where(member)
        )

        def excluded(name: str, model):
            return (
                select(
                    part(name),
                    no_text,
                    no_text,
                    no_number,
                    no_text,
                    func.count(),
                    zero,
                    zero,
                    zero,
                    zero,
                )
                .select_from(model)
                .join(AgentSession, AgentSession.id == model.session_id)
                .where(~_owner_is_member())
            )

        children = (
            select(
                part("children"),
                no_text,
                no_text,
                no_number,
                no_text,
                func.count(),
                zero,
                zero,
                zero,
                zero,
            )
            .select_from(AgentSession)
            .where(member, AgentSession.parent_session_id.is_not(None))
        )
        unresolved = (
            select(
                part("unresolved_metadata"),
                no_text,
                no_text,
                no_number,
                no_text,
                func.count(),
                zero,
                zero,
                zero,
                zero,
            )
            .select_from(Content)
            .join(AgentSession, AgentSession.id == Content.session_id)
            .where(
                member,
                _retained_text(),
                self._untrusted_metadata(backend, max_body_bytes),
            )
        )
        rows = await self.db.execute(
            union_all(
                contents,
                events,
                excluded("excluded_content", Content),
                excluded("excluded_event", Event),
                children,
                unresolved,
            )
        )
        aggregate = {
            "contents": [],
            "events_stored": 0,
            "events_indexed": 0,
            "events_indexed_bytes": 0,
            "owner_not_member": 0,
            "child_sessions": 0,
            "unresolved_metadata": 0,
        }
        for row in rows:
            name, state, coverage, is_text, index_status = row[:5]
            items, stored, stored_known, original, original_known = (
                int(value) for value in row[5:]
            )
            if name == "content":
                aggregate["contents"].append(
                    ContentCoverageRow(
                        state=state,
                        coverage=coverage,
                        is_text=bool(is_text),
                        index_status=index_status,
                        unverified=False,
                        count=items,
                        stored_bytes=stored,
                        stored_known=stored_known,
                        original_bytes=original,
                        original_known=original_known,
                    )
                )
            elif name == "event":
                aggregate["events_stored"] = items
                aggregate["events_indexed_bytes"] = stored
                aggregate["events_indexed"] = stored_known
            elif name == "children":
                aggregate["child_sessions"] = items
            elif name == "unresolved_metadata":
                aggregate["unresolved_metadata"] = items
            else:
                aggregate["owner_not_member"] += items
        return ScopeAggregate(**aggregate)
