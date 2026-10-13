# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    String,
    and_,
    case,
    cast,
    delete,
    extract,
    false,
    func,
    not_,
    or_,
    select,
    text,
    true,
    update,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import (
    AgentSession,
    AgentSessionCapture,
    AgentSessionContentDeletion,
    AgentSessionEvent,
    AgentSessionTombstone,
    NON_ACTIVITY_ACTIONS,
    SessionWorkLink,
)
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.notes.note import Note
from app.models.workspace import WorkspaceMember
from app.repositories.dialect_insert import conflict_aware_insert
from app.core.session_content_keys import session_prefix

# Bound on any walk along parent links (subagent threads nest a few levels).
MAX_THREAD_DEPTH = 1000

# The list's sort orders, newest or largest first. Duration and cost are
# compared as whole milliseconds and micro-dollars so a keyset cursor can
# match a row's key exactly on both dialects.
LIST_SORTS = ("recent", "started", "duration", "tokens", "cost")


@dataclass(frozen=True)
class CaptureSwitches:
    """The owner's devices as display_state reads them, for filtering in SQL.
    A paused device pauses every harness; otherwise only the harnesses in
    `capturing_harnesses` keep capturing."""

    paused: set[uuid.UUID] = field(default_factory=set)
    capturing_harnesses: dict[uuid.UUID, set[str]] = field(default_factory=dict)
    disconnected: set[uuid.UUID] = field(default_factory=set)


@dataclass(frozen=True)
class LinkPreviewRow:
    entity_type: str
    entity_id: uuid.UUID
    board_id: uuid.UUID | None
    title: str
    relation: str
    provenance: str


def epoch_seconds(dialect_name: str, column):
    if dialect_name == "postgresql":
        return extract("epoch", column)
    # SQLite keeps UTC timestamps as text; julianday reads them as days. Its
    # float carries ~20 microseconds of error, so callers compare whole
    # milliseconds, never raw seconds.
    return (func.julianday(column) - 2440587.5) * 86400.0


def like_pattern(text_value: str) -> str:
    escaped = text_value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


RECEIPT_FACTS_BATCH = 500
SESSION_IDENTITY = (
    "workspace_id",
    "owner_id",
    "installation_id",
    "harness",
    "native_session_id",
)


class AgentSessionRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def capture_receipt(
        self, installation_id: uuid.UUID, capture_id: str
    ) -> AgentSessionCapture | None:
        return await self.db.scalar(
            select(AgentSessionCapture).where(
                AgentSessionCapture.installation_id == installation_id,
                AgentSessionCapture.capture_id == capture_id,
            )
        )

    async def activity_event_counts(
        self, session_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, int]:
        """Activity events stored per session; sessions with none are absent."""
        if not session_ids:
            return {}
        rows = await self.db.execute(
            select(AgentSessionEvent.session_id, func.count())
            .where(
                AgentSessionEvent.session_id.in_(session_ids),
                AgentSessionEvent.action.not_in(NON_ACTIVITY_ACTIONS),
            )
            .group_by(AgentSessionEvent.session_id)
        )
        return dict(rows.tuples().all())

    async def lock_next_session(
        self, after: uuid.UUID | None, *, only_uncounted: bool
    ) -> AgentSession | None:
        query = select(AgentSession)
        if after is not None:
            query = query.where(AgentSession.id > after)
        if only_uncounted:
            query = query.where(AgentSession.activity_event_count.is_(None))
        return await self.db.scalar(
            query.order_by(AgentSession.id)
            .limit(1)
            # The same lock ingest takes, so a recount never interleaves with
            # an upload's summary deltas.
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )

    async def capture_content_levels(
        self, installation_id: uuid.UUID, capture_ids: set[str]
    ) -> dict[str, str | None]:
        if not capture_ids:
            return {}
        rows = await self.db.execute(
            select(
                AgentSessionCapture.capture_id, AgentSessionCapture.content_level
            ).where(
                AgentSessionCapture.installation_id == installation_id,
                AgentSessionCapture.capture_id.in_(capture_ids),
            )
        )
        return dict(rows.tuples().all())

    async def insert_capture_receipt(self, **values) -> bool:
        inserted = await self.db.scalar(
            conflict_aware_insert(self.db, AgentSessionCapture)
            .values(id=uuid.uuid4(), **values)
            .on_conflict_do_nothing(index_elements=["installation_id", "capture_id"])
            .returning(AgentSessionCapture.id)
        )
        return inserted is not None

    async def lock_or_create_session(
        self, identity: dict, defaults: dict
    ) -> AgentSession:
        """The session row, created if new and locked for this transaction so
        concurrent uploads apply their summary deltas one at a time."""
        await self.db.execute(
            conflict_aware_insert(self.db, AgentSession)
            .values(id=uuid.uuid4(), **identity, **defaults)
            .on_conflict_do_nothing(index_elements=list(SESSION_IDENTITY))
        )
        return await self.db.scalar(
            select(AgentSession)
            .filter_by(**identity)
            # FOR NO KEY UPDATE: link rows that reference this session take KEY
            # SHARE for their FK check and must not queue behind this lock.
            .with_for_update(key_share=True)
            .execution_options(populate_existing=True)
        )

    async def ancestor_ids(self, session_id: uuid.UUID) -> set[uuid.UUID]:
        """`session_id` and every session above it, walked with a visited set
        and a depth bound so even corrupt data cannot loop forever."""
        seen: set[uuid.UUID] = set()
        current: uuid.UUID | None = session_id
        while (
            current is not None and current not in seen and len(seen) < MAX_THREAD_DEPTH
        ):
            seen.add(current)
            current = await self.db.scalar(
                select(AgentSession.parent_session_id).where(AgentSession.id == current)
            )
        return seen

    async def link_parent(self, session: AgentSession) -> None:
        """Point `session` at its declared parent, if that session exists and
        the link would not close a cycle."""
        parent_id = await self.db.scalar(
            select(AgentSession.id).where(
                AgentSession.workspace_id == session.workspace_id,
                AgentSession.owner_id == session.owner_id,
                AgentSession.installation_id == session.installation_id,
                AgentSession.harness == session.harness,
                AgentSession.native_session_id == session.parent_native_session_id,
            )
        )
        if parent_id is not None and session.id not in await self.ancestor_ids(
            parent_id
        ):
            session.parent_session_id = parent_id

    async def adopt_waiting_children(self, parent: AgentSession) -> None:
        """Attach child sessions that arrived before `parent` did, except any
        that is already above `parent` (which would close a cycle)."""
        ancestors = await self.ancestor_ids(parent.id)
        await self.db.execute(
            update(AgentSession)
            .where(
                AgentSession.workspace_id == parent.workspace_id,
                AgentSession.owner_id == parent.owner_id,
                AgentSession.installation_id == parent.installation_id,
                AgentSession.harness == parent.harness,
                AgentSession.parent_native_session_id == parent.native_session_id,
                AgentSession.parent_session_id.is_(None),
                AgentSession.id.not_in(ancestors),
            )
            .values(parent_session_id=parent.id)
            .execution_options(synchronize_session=False)
        )

    async def insert_new_events(self, rows: list[dict]) -> set[str]:
        """Insert events, skipping ones already stored; returns the new event ids."""
        if not rows:
            return set()
        inserted = await self.db.scalars(
            conflict_aware_insert(self.db, AgentSessionEvent)
            .values(rows)
            .on_conflict_do_nothing(index_elements=["session_id", "event_id"])
            .returning(AgentSessionEvent.event_id)
        )
        return set(inserted)

    async def known_tool_calls(
        self, session_id: uuid.UUID, call_ids: set[str]
    ) -> set[str]:
        """Which of `call_ids` this session already has an event for."""
        if not call_ids:
            return set()
        result = await self.db.scalars(
            select(AgentSessionEvent.native_tool_call_id)
            .where(
                AgentSessionEvent.session_id == session_id,
                AgentSessionEvent.native_tool_call_id.in_(call_ids),
            )
            .distinct()
        )
        return set(result)

    async def get_owned(
        self, workspace_id: uuid.UUID, owner_id: uuid.UUID, session_id: uuid.UUID
    ) -> AgentSession | None:
        return await self.db.scalar(
            select(AgentSession).where(
                AgentSession.id == session_id,
                AgentSession.workspace_id == workspace_id,
                AgentSession.owner_id == owner_id,
            )
        )

    def _dialect(self) -> str:
        return self.db.get_bind().dialect.name

    def epoch_seconds(self, column):
        return epoch_seconds(self._dialect(), column)

    def list_sort_key(self, sort: str):
        if sort == "started":
            return AgentSession.started_at
        if sort == "duration":
            span = self.epoch_seconds(AgentSession.last_event_at) - self.epoch_seconds(
                AgentSession.started_at
            )
            return cast(func.round(span * 1000), BigInteger)
        if sort == "tokens":
            return (
                AgentSession.input_tokens
                + AgentSession.output_tokens
                + AgentSession.cache_read_tokens
                + AgentSession.cache_creation_tokens
            )
        if sort == "cost":
            return cast(func.round(AgentSession.cost_usd * 1_000_000), BigInteger)
        return AgentSession.last_event_at

    def _owner_scope(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        board_id: uuid.UUID | None,
        harness: str | None,
        root_only: bool,
        since: datetime | None,
    ) -> list:
        conditions = [
            AgentSession.workspace_id == workspace_id,
            AgentSession.owner_id == owner_id,
        ]
        if board_id is not None:
            conditions.append(AgentSession.board_id == board_id)
        if harness is not None:
            conditions.append(AgentSession.harness == harness)
        if root_only:
            # A declared child is not a root even before its parent arrives.
            conditions.append(AgentSession.parent_native_session_id.is_(None))
        if since is not None:
            conditions.append(AgentSession.last_event_at >= since)
        return conditions

    async def list_owned(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        board_id: uuid.UUID | None,
        harness: str | None,
        status: str | None,
        states: list[str] | None,
        switches: CaptureSwitches,
        q: str | None,
        linked_only: bool,
        since: datetime | None,
        idle_before: datetime,
        abandoned_before: datetime,
        root_only: bool,
        sort: str,
        after: tuple[object, uuid.UUID] | None,
        limit: int,
    ) -> list[tuple[AgentSession, object]]:
        """A page of the owner's sessions with each row's sort key, every
        filter applied before the keyset so pages never come back short."""
        sort_key = self.list_sort_key(sort)
        query = select(AgentSession, sort_key.label("sort_key")).where(
            *self._owner_scope(
                workspace_id,
                owner_id,
                board_id=board_id,
                harness=harness,
                root_only=root_only,
                since=since,
            ),
            self._status_clause(status, idle_before, abandoned_before),
        )
        if q:
            pattern = like_pattern(q)
            query = query.where(
                or_(
                    AgentSession.title.ilike(pattern, escape="\\"),
                    AgentSession.repository.ilike(pattern, escape="\\"),
                    AgentSession.branch.ilike(pattern, escape="\\"),
                    AgentSession.board_id.in_(
                        select(Board.id).where(
                            Board.workspace_id == workspace_id,
                            Board.name.ilike(pattern, escape="\\"),
                        )
                    ),
                )
            )
        if linked_only:
            query = query.where(
                self._visible_links(owner_id)
                .where(SessionWorkLink.session_id == AgentSession.id)
                .exists()
            )
        if states:
            query = query.where(
                self.display_state_clause(
                    states, switches, idle_before, abandoned_before
                )
            )
        nullable_key = sort == "cost"
        if after is not None:
            last_key, last_id = after
            if last_key is None:
                query = query.where(sort_key.is_(None), AgentSession.id < last_id)
            else:
                query = query.where(
                    or_(
                        sort_key < last_key,
                        and_(sort_key == last_key, AgentSession.id < last_id),
                        *([sort_key.is_(None)] if nullable_key else []),
                    )
                )
        order = [sort_key.desc(), AgentSession.id.desc()]
        if nullable_key:
            # NULLS LAST on both dialects: PostgreSQL puts them first on DESC.
            order.insert(0, sort_key.is_(None))
        result = await self.db.execute(query.order_by(*order).limit(limit))
        return list(result.tuples())

    async def period_totals(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        board_id: uuid.UUID | None,
        harness: str | None,
        root_only: bool,
        since: datetime | None,
        live,
        spend_auth_kinds: frozenset[str],
    ):
        """One row of sums over the owner's matching sessions; `live` is the
        clause a session counts as live under."""
        spent = AgentSession.auth_kind.in_(spend_auth_kinds)
        used_tokens = or_(
            AgentSession.input_tokens > 0,
            AgentSession.output_tokens > 0,
            AgentSession.cache_read_tokens > 0,
            AgentSession.cache_creation_tokens > 0,
            AgentSession.cost_usd.is_not(None),
        )
        unpriced = and_(
            used_tokens,
            or_(
                AgentSession.cost_usd.is_(None),
                AgentSession.unpriced_usage_count > 0,
            ),
        )

        def total(column):
            return func.coalesce(func.sum(column), 0)

        result = await self.db.execute(
            select(
                func.count().label("session_count"),
                total(case((live, 1), else_=0)).label("live_count"),
                total(AgentSession.input_tokens).label("input_tokens"),
                total(AgentSession.output_tokens).label("output_tokens"),
                total(AgentSession.cache_read_tokens).label("cache_read_tokens"),
                total(AgentSession.cache_creation_tokens).label(
                    "cache_creation_tokens"
                ),
                total(AgentSession.reasoning_tokens).label("reasoning_tokens"),
                # CASE without ELSE is NULL, so a NULL auth kind lands on the
                # api-equivalent side and SUM skips the other basis entirely.
                func.sum(case((spent, AgentSession.cost_usd))).label("spend"),
                func.sum(case((spent, None), else_=AgentSession.cost_usd)).label(
                    "api_equivalent"
                ),
                total(case((unpriced, 1), else_=0)).label("unpriced_sessions"),
            ).where(
                *self._owner_scope(
                    workspace_id,
                    owner_id,
                    board_id=board_id,
                    harness=harness,
                    root_only=root_only,
                    since=since,
                )
            )
        )
        return result.one()

    async def period_spans(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        board_id: uuid.UUID | None,
        harness: str | None,
        root_only: bool,
        since: datetime | None,
    ) -> list[tuple[datetime, datetime]]:
        result = await self.db.execute(
            select(AgentSession.started_at, AgentSession.last_event_at).where(
                *self._owner_scope(
                    workspace_id,
                    owner_id,
                    board_id=board_id,
                    harness=harness,
                    root_only=root_only,
                    since=since,
                )
            )
        )
        return list(result.tuples())

    @staticmethod
    def display_state_clause(
        states: list[str],
        switches: CaptureSwitches,
        idle_before: datetime,
        abandoned_before: datetime,
    ):
        """Sessions whose display_state is one of `states`. Mirrors
        display_state in app/services/agent_session.py, precedence included;
        every branch is NULL-safe so its negation never drops a row."""
        really_ended = and_(
            AgentSession.ended_at.is_not(None),
            AgentSession.ended_at >= AgentSession.last_event_at,
        )
        mapping_off = and_(
            AgentSession.mapping_id.is_not(None),
            AgentSession.mapping_id.in_(
                select(CompanionProjectMapping.id).where(
                    CompanionProjectMapping.enabled.is_(False)
                )
            ),
        )
        harness_off = [
            and_(
                AgentSession.installation_id == installation_id,
                AgentSession.harness.not_in(harnesses),
            )
            for installation_id, harnesses in switches.capturing_harnesses.items()
        ]
        device_paused = (
            AgentSession.installation_id.in_(switches.paused)
            if switches.paused
            else false()
        )
        paused = and_(not_(really_ended), or_(device_paused, mapping_off, *harness_off))
        open_and_capturing = and_(not_(really_ended), not_(paused))
        abandoned = AgentSession.last_event_at < abandoned_before
        device_unreachable = (
            AgentSession.installation_id.in_(switches.disconnected)
            if switches.disconnected
            else false()
        )
        disconnected = and_(open_and_capturing, not_(abandoned), device_unreachable)
        reachable = and_(open_and_capturing, not_(abandoned), not_(device_unreachable))
        by_state = {
            "ended": and_(really_ended, AgentSession.capture_gaps == 0),
            "incomplete": or_(
                and_(really_ended, AgentSession.capture_gaps > 0),
                and_(open_and_capturing, abandoned),
            ),
            "paused": paused,
            "disconnected": disconnected,
            "active": and_(reachable, AgentSession.last_event_at >= idle_before),
            "idle": and_(reachable, AgentSession.last_event_at < idle_before),
        }
        return or_(*(by_state[state] for state in states))

    async def owner_installations(
        self, owner_id: uuid.UUID
    ) -> list[CompanionInstallation]:
        result = await self.db.scalars(
            select(CompanionInstallation).where(
                CompanionInstallation.owner_id == owner_id
            )
        )
        return list(result)

    async def child_counts(
        self, owner_id: uuid.UUID, session_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, int]:
        if not session_ids:
            return {}
        rows = await self.db.execute(
            select(AgentSession.parent_session_id, func.count())
            .where(
                AgentSession.owner_id == owner_id,
                AgentSession.parent_session_id.in_(session_ids),
            )
            .group_by(AgentSession.parent_session_id)
        )
        return dict(rows.tuples().all())

    async def link_previews(
        self, owner_id: uuid.UUID, session_ids: set[uuid.UUID], per_session: int
    ) -> dict[uuid.UUID, tuple[int, list[LinkPreviewRow]]]:
        """Per session: how many distinct cards and notes it touched that the
        owner can still see, and the first `per_session` of them, changed
        before consulted, then the most recently touched. One statement."""
        if not session_ids:
            return {}
        links = (
            self._visible_links(owner_id)
            .where(SessionWorkLink.session_id.in_(session_ids))
            .subquery()
        )
        # One row per entity: its changed link when it has one.
        per_entity = select(
            links,
            func.row_number()
            .over(
                partition_by=(
                    links.c.session_id,
                    links.c.entity_type,
                    links.c.entity_id,
                ),
                order_by=(
                    case((links.c.relation == "changed", 0), else_=1),
                    links.c.last_seen_at.desc(),
                ),
            )
            .label("entity_rank"),
        ).subquery()
        entities = select(per_entity).where(per_entity.c.entity_rank == 1).subquery()
        ranked = select(
            entities,
            func.row_number()
            .over(
                partition_by=entities.c.session_id,
                order_by=(
                    case((entities.c.relation == "changed", 0), else_=1),
                    entities.c.last_seen_at.desc(),
                    entities.c.entity_type,
                    entities.c.entity_id,
                ),
            )
            .label("rank"),
            func.count().over(partition_by=entities.c.session_id).label("total"),
        ).subquery()
        is_card = ranked.c.entity_type == "card"
        rows = await self.db.execute(
            select(
                ranked.c.session_id,
                ranked.c.total,
                ranked.c.entity_type,
                ranked.c.entity_id,
                case((is_card, Card.board_id), else_=Note.board_id).label("board_id"),
                func.coalesce(Card.title, Note.title).label("title"),
                ranked.c.relation,
                ranked.c.invocation_count,
                ranked.c.correlated_count,
            )
            .outerjoin(Card, and_(is_card, Card.id == ranked.c.entity_id))
            .outerjoin(
                Note,
                and_(ranked.c.entity_type == "note", Note.id == ranked.c.entity_id),
            )
            .where(ranked.c.rank <= per_session)
            .order_by(ranked.c.session_id, ranked.c.rank)
        )
        previews: dict[uuid.UUID, tuple[int, list[LinkPreviewRow]]] = {}
        for row in rows:
            _, items = previews.setdefault(row.session_id, (row.total, []))
            items.append(
                LinkPreviewRow(
                    entity_type=row.entity_type,
                    entity_id=row.entity_id,
                    board_id=row.board_id,
                    title=row.title,
                    relation=row.relation,
                    # The rule of SessionWorkLink.provenance.
                    provenance="correlated"
                    if row.correlated_count >= row.invocation_count
                    else "exact",
                )
            )
        return previews

    @staticmethod
    def _in_member_workspace(owner_id: uuid.UUID):
        return AgentSession.workspace_id.in_(
            select(WorkspaceMember.workspace_id).where(
                WorkspaceMember.user_id == owner_id
            )
        )

    async def list_of_installation(
        self,
        installation_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        status: str | None,
        idle_before: datetime,
        abandoned_before: datetime,
        after: tuple[datetime, uuid.UUID] | None,
        limit: int,
    ) -> list[AgentSession]:
        """One device's sessions, across the workspaces its owner still belongs to."""
        query = select(AgentSession).where(
            AgentSession.installation_id == installation_id,
            AgentSession.owner_id == owner_id,
            self._in_member_workspace(owner_id),
        )
        return await self._page(
            query,
            status=status,
            idle_before=idle_before,
            abandoned_before=abandoned_before,
            after=after,
            limit=limit,
        )

    async def get_of_installation(
        self, installation_id: uuid.UUID, owner_id: uuid.UUID, session_id: uuid.UUID
    ) -> AgentSession | None:
        return await self.db.scalar(
            select(AgentSession).where(
                AgentSession.id == session_id,
                AgentSession.installation_id == installation_id,
                AgentSession.owner_id == owner_id,
                self._in_member_workspace(owner_id),
            )
        )

    async def _page(
        self,
        query,
        *,
        status: str | None,
        idle_before: datetime,
        abandoned_before: datetime,
        after: tuple[datetime, uuid.UUID] | None,
        limit: int,
    ) -> list[AgentSession]:
        query = query.where(self._status_clause(status, idle_before, abandoned_before))
        if after is not None:
            last_event_at, last_id = after
            query = query.where(
                or_(
                    AgentSession.last_event_at < last_event_at,
                    and_(
                        AgentSession.last_event_at == last_event_at,
                        AgentSession.id < last_id,
                    ),
                )
            )
        result = await self.db.scalars(
            query.order_by(
                AgentSession.last_event_at.desc(), AgentSession.id.desc()
            ).limit(limit)
        )
        return list(result)

    @staticmethod
    def _status_clause(
        status: str | None, idle_before: datetime, abandoned_before: datetime
    ):
        # Mirrors lifecycle_status in app/services/agent_session.py.
        still_open = AgentSession.status == "active"
        if status == "active":
            return and_(still_open, AgentSession.last_event_at >= idle_before)
        if status == "idle":
            return and_(
                still_open,
                AgentSession.last_event_at < idle_before,
                AgentSession.last_event_at >= abandoned_before,
            )
        if status == "ended":
            return or_(
                AgentSession.status == "ended",
                AgentSession.last_event_at < abandoned_before,
            )
        return true()

    async def list_events(
        self,
        session_id: uuid.UUID,
        *,
        action: str | None,
        category: str | None,
        after: tuple[datetime, uuid.UUID] | None,
        limit: int,
    ) -> list[AgentSessionEvent]:
        query = select(AgentSessionEvent).where(
            AgentSessionEvent.session_id == session_id
        )
        if action is not None:
            query = query.where(AgentSessionEvent.action == action)
        if category is not None:
            query = query.where(AgentSessionEvent.category == category)
        if after is not None:
            occurred_at, last_id = after
            query = query.where(
                or_(
                    AgentSessionEvent.occurred_at > occurred_at,
                    and_(
                        AgentSessionEvent.occurred_at == occurred_at,
                        AgentSessionEvent.id > last_id,
                    ),
                )
            )
        result = await self.db.scalars(
            query.order_by(AgentSessionEvent.occurred_at, AgentSessionEvent.id).limit(
                limit
            )
        )
        return list(result)

    def _visible_links(self, owner_id: uuid.UUID):
        """Links whose workspace the owner still belongs to and whose card or
        note still exists there."""
        card_visible = (
            select(Card.id)
            .join(Board, Card.board_id == Board.id)
            .where(
                Card.id == SessionWorkLink.entity_id,
                Board.workspace_id == SessionWorkLink.workspace_id,
            )
        )
        note_visible = select(Note.id).where(
            Note.id == SessionWorkLink.entity_id,
            Note.workspace_id == SessionWorkLink.workspace_id,
        )
        return select(SessionWorkLink).where(
            SessionWorkLink.workspace_id.in_(
                select(WorkspaceMember.workspace_id).where(
                    WorkspaceMember.user_id == owner_id
                )
            ),
            or_(
                and_(SessionWorkLink.entity_type == "card", card_visible.exists()),
                and_(SessionWorkLink.entity_type == "note", note_visible.exists()),
            ),
        )

    async def visible_links(
        self, session_id: uuid.UUID, owner_id: uuid.UUID
    ) -> list[SessionWorkLink]:
        result = await self.db.scalars(
            self._visible_links(owner_id)
            .where(SessionWorkLink.session_id == session_id)
            .order_by(
                SessionWorkLink.last_seen_at.desc(),
                SessionWorkLink.entity_type,
                SessionWorkLink.relation,
            )
        )
        return list(result)

    async def owned_sessions_linked_to(
        self, owner_id: uuid.UUID, entity_type: str, entity_id: uuid.UUID
    ) -> list[tuple[AgentSession, SessionWorkLink]]:
        links = self._visible_links(owner_id).subquery()
        result = await self.db.execute(
            select(AgentSession, SessionWorkLink)
            .join(SessionWorkLink, SessionWorkLink.session_id == AgentSession.id)
            .where(
                SessionWorkLink.id.in_(select(links.c.id)),
                SessionWorkLink.entity_type == entity_type,
                SessionWorkLink.entity_id == entity_id,
                AgentSession.owner_id == owner_id,
                AgentSession.workspace_id.in_(
                    select(WorkspaceMember.workspace_id).where(
                        WorkspaceMember.user_id == owner_id
                    )
                ),
            )
            .order_by(AgentSession.last_event_at.desc(), AgentSession.id.desc())
        )
        return list(result.tuples())

    async def card_on_board(
        self, workspace_id: uuid.UUID, board_id: uuid.UUID, card_id: uuid.UUID
    ) -> bool:
        found = await self.db.scalar(
            select(Card.id)
            .join(Board, Card.board_id == Board.id)
            .where(
                Card.id == card_id,
                Card.board_id == board_id,
                Board.workspace_id == workspace_id,
            )
        )
        return found is not None

    async def is_member(self, workspace_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        found = await self.db.scalar(
            select(WorkspaceMember.user_id).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user_id,
            )
        )
        return found is not None

    # --- capture context, for display state ---

    async def installations(
        self, installation_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, CompanionInstallation]:
        if not installation_ids:
            return {}
        result = await self.db.scalars(
            select(CompanionInstallation).where(
                CompanionInstallation.id.in_(installation_ids)
            )
        )
        return {installation.id: installation for installation in result}

    async def disabled_mappings(self, mapping_ids: set[uuid.UUID]) -> set[uuid.UUID]:
        if not mapping_ids:
            return set()
        result = await self.db.scalars(
            select(CompanionProjectMapping.id).where(
                CompanionProjectMapping.id.in_(mapping_ids),
                CompanionProjectMapping.enabled.is_(False),
            )
        )
        return set(result)

    async def owned_children(
        self, workspace_id: uuid.UUID, owner_id: uuid.UUID, parent_id: uuid.UUID
    ) -> list[AgentSession]:
        result = await self.db.scalars(
            select(AgentSession)
            .where(
                AgentSession.workspace_id == workspace_id,
                AgentSession.owner_id == owner_id,
                AgentSession.parent_session_id == parent_id,
            )
            .order_by(AgentSession.started_at, AgentSession.id)
        )
        return list(result)

    async def owned_children_of(
        self, owner_id: uuid.UUID, parent_ids: list[uuid.UUID]
    ) -> list[AgentSession]:
        result = await self.db.scalars(
            select(AgentSession).where(
                AgentSession.owner_id == owner_id,
                AgentSession.parent_session_id.in_(parent_ids),
            )
        )
        return list(result)

    async def note_in_workspace(
        self, workspace_id: uuid.UUID, note_id: uuid.UUID
    ) -> bool:
        found = await self.db.scalar(
            select(Note.id).where(Note.id == note_id, Note.workspace_id == workspace_id)
        )
        return found is not None

    # --- deletion ---

    async def sessions_of_installation(
        self, installation_id: uuid.UUID
    ) -> list[AgentSession]:
        result = await self.db.scalars(
            select(AgentSession).where(AgentSession.installation_id == installation_id)
        )
        return list(result)

    async def session_counts_by_installation(
        self, installation_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, int]:
        """Across every workspace, exactly what `sessions_of_installation` returns."""
        if not installation_ids:
            return {}
        rows = await self.db.execute(
            select(AgentSession.installation_id, func.count())
            .where(AgentSession.installation_id.in_(installation_ids))
            .group_by(AgentSession.installation_id)
        )
        return {installation_id: count for installation_id, count in rows.all()}

    async def tombstone_and_delete(
        self,
        sessions: list[AgentSession],
        reason: str,
        deleted_at: datetime,
        history_cutoffs: dict[uuid.UUID, datetime],
        content_backend: str,
    ) -> None:
        """Replace each session by its tombstone, carrying the history cutoff
        given for it by session id; events, receipts, matches, links and
        content rows go with it through the foreign keys' cascades. A
        tombstone's cutoff only ever moves on, whatever a later deletion
        computes.

        In the same transaction, before the rows go: each doomed session with
        content queues its storage prefix (in `content_backend`, the store the
        caller writes bodies to) for the purge, and its reserved bytes
        leave its device's total. Sessions are locked first, then devices in id
        order, as every content counter is."""
        if not sessions:
            return
        await self._release_contents(sessions, deleted_at, content_backend)
        insert = conflict_aware_insert(self.db, AgentSessionTombstone).values(
            [
                {
                    "id": uuid.uuid4(),
                    "session_id": session.id,
                    "installation_id": session.installation_id,
                    "workspace_id": session.workspace_id,
                    "owner_id": session.owner_id,
                    "harness": session.harness,
                    "native_session_id": session.native_session_id,
                    "reason": reason,
                    "deleted_at": deleted_at,
                    "history_cutoff": history_cutoffs[session.id],
                    "history_cutoff_deleted_at": deleted_at,
                }
                for session in sessions
            ]
        )
        stored_cutoff = AgentSessionTombstone.__table__.c.history_cutoff
        new_cutoff = insert.excluded.history_cutoff
        await self.db.execute(
            insert.on_conflict_do_update(
                index_elements=list(SESSION_IDENTITY),
                set_={
                    "session_id": insert.excluded.session_id,
                    "reason": insert.excluded.reason,
                    "deleted_at": insert.excluded.deleted_at,
                    # GREATEST, spelled so SQLite runs it too.
                    "history_cutoff": case(
                        (stored_cutoff.is_(None), new_cutoff),
                        (new_cutoff > stored_cutoff, new_cutoff),
                        else_=stored_cutoff,
                    ),
                    "history_cutoff_deleted_at": (
                        insert.excluded.history_cutoff_deleted_at
                    ),
                },
            )
        )
        await self.db.execute(
            delete(AgentSession)
            .where(AgentSession.id.in_([session.id for session in sessions]))
            .execution_options(synchronize_session=False)
        )

    async def _release_contents(
        self, sessions: list[AgentSession], now: datetime, backend: str
    ) -> None:
        held = (
            await self.db.execute(
                select(
                    AgentSession.id,
                    AgentSession.workspace_id,
                    AgentSession.owner_id,
                    AgentSession.installation_id,
                    AgentSession.content_bytes,
                    AgentSession.content_count,
                )
                .where(AgentSession.id.in_([session.id for session in sessions]))
                .order_by(AgentSession.id)
                .with_for_update()
            )
        ).all()
        with_content = [row for row in held if row.content_count or row.content_bytes]
        if not with_content:
            return
        self.db.add_all(
            AgentSessionContentDeletion(
                storage_backend=backend,
                storage_prefix=session_prefix(
                    row.workspace_id, row.owner_id, row.installation_id, row.id
                ),
                requested_at=now,
                next_attempt_at=now,
            )
            for row in with_content
        )
        released: dict[uuid.UUID, int] = {}
        for row in with_content:
            released[row.installation_id] = (
                released.get(row.installation_id, 0) + row.content_bytes
            )
        for installation_id in sorted(released):
            if released[installation_id]:
                await self.db.execute(
                    update(CompanionInstallation)
                    .where(CompanionInstallation.id == installation_id)
                    .values(
                        content_bytes=CompanionInstallation.content_bytes
                        - released[installation_id]
                    )
                    .execution_options(synchronize_session=False)
                )
        await self.db.flush()

    async def tombstones_of(
        self, sessions: list[AgentSession]
    ) -> dict[tuple, AgentSessionTombstone]:
        """Earlier tombstones of these sessions' identities, by identity."""
        if not sessions:
            return {}
        found = await self.db.scalars(
            select(AgentSessionTombstone).where(
                AgentSessionTombstone.installation_id.in_(
                    {session.installation_id for session in sessions}
                ),
                AgentSessionTombstone.native_session_id.in_(
                    {session.native_session_id for session in sessions}
                ),
            )
        )
        return {
            tuple(getattr(tombstone, key) for key in SESSION_IDENTITY): tombstone
            for tombstone in found
        }

    async def receipt_clock_facts(
        self, session_ids: list[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[datetime | None, float | None]]:
        """Per installation, over these sessions' receipts: the latest
        captured_at, and the most the device clock read ahead of the
        server's on receipt, in seconds."""
        if self.db.get_bind().dialect.name == "postgresql":
            # EXTRACT(EPOCH ...) is NUMERIC, which asyncpg hands over as Decimal.
            lead_seconds = cast(
                extract(
                    "epoch",
                    AgentSessionCapture.captured_at - AgentSessionCapture.received_at,
                ),
                Float,
            )
        else:
            lead_seconds = (
                func.julianday(AgentSessionCapture.captured_at)
                - func.julianday(AgentSessionCapture.received_at)
            ) * 86400.0
        facts: dict[uuid.UUID, tuple[datetime | None, float | None]] = {}
        for start in range(0, len(session_ids), RECEIPT_FACTS_BATCH):
            rows = await self.db.execute(
                select(
                    AgentSessionCapture.installation_id,
                    func.max(AgentSessionCapture.captured_at),
                    func.max(lead_seconds),
                )
                .where(
                    AgentSessionCapture.session_id.in_(
                        session_ids[start : start + RECEIPT_FACTS_BATCH]
                    )
                )
                .group_by(AgentSessionCapture.installation_id)
            )
            for installation_id, latest_captured, lead in rows.all():
                known_captured, known_lead = facts.get(installation_id, (None, None))
                facts[installation_id] = (
                    max(filter(None, [known_captured, latest_captured]), default=None),
                    max(
                        (value for value in [known_lead, lead] if value is not None),
                        default=None,
                    ),
                )
        return facts

    async def deleted_by_owner(
        self, owner_id: uuid.UUID, session_id: uuid.UUID
    ) -> bool:
        found = await self.db.scalar(
            select(AgentSessionTombstone.id).where(
                AgentSessionTombstone.owner_id == owner_id,
                AgentSessionTombstone.session_id == session_id,
            )
        )
        return found is not None

    async def tombstones_in_any_workspace(
        self,
        owner_id: uuid.UUID,
        installation_id: uuid.UUID,
        harness: str,
        native_session_id: str,
    ) -> list[AgentSessionTombstone]:
        result = await self.db.scalars(
            select(AgentSessionTombstone)
            .where(
                AgentSessionTombstone.owner_id == owner_id,
                AgentSessionTombstone.installation_id == installation_id,
                AgentSessionTombstone.harness == harness,
                AgentSessionTombstone.native_session_id == native_session_id,
            )
            .execution_options(populate_existing=True)
        )
        return list(result)

    async def recent_capture_times(
        self, installation_id: uuid.UUID, limit: int
    ) -> list[tuple[datetime, datetime]]:
        """(captured_at, received_at) of the device's latest receipts: its own
        clock beside the server's for the same records."""
        rows = await self.db.execute(
            select(AgentSessionCapture.captured_at, AgentSessionCapture.received_at)
            .where(AgentSessionCapture.installation_id == installation_id)
            .order_by(AgentSessionCapture.received_at.desc())
            .limit(limit)
        )
        return [(captured_at, received_at) for captured_at, received_at in rows.all()]

    async def count_capture_gap(self, identity: dict) -> None:
        await self.db.execute(
            update(AgentSession)
            .filter_by(**identity)
            .values(capture_gaps=AgentSession.capture_gaps + 1)
            .execution_options(synchronize_session=False)
        )

    # --- retention ---

    async def sessions_past_retention(
        self, now: datetime, limit: int
    ) -> list[AgentSession]:
        """Up to `limit` sessions older than their device's retention, in one
        query, locked and skipped by any concurrent purge (PostgreSQL)."""
        if self.db.get_bind().dialect.name == "postgresql":
            cutoff = func.cast(now, DateTime(timezone=True)) - (
                CompanionInstallation.retention_days * text("interval '1 day'")
            )
        else:
            # SQLite keeps UTC timestamps as ISO text; datetime() compares as text.
            cutoff = func.datetime(
                now.strftime("%Y-%m-%d %H:%M:%S.%f"),
                "-" + func.cast(CompanionInstallation.retention_days, String) + " days",
            )
        result = await self.db.scalars(
            select(AgentSession)
            .join(
                CompanionInstallation,
                CompanionInstallation.id == AgentSession.installation_id,
            )
            .where(
                CompanionInstallation.retention_days.is_not(None),
                AgentSession.last_event_at < cutoff,
            )
            .order_by(AgentSession.last_event_at, AgentSession.id)
            .limit(limit)
            .with_for_update(skip_locked=True, of=AgentSession)
        )
        return list(result)

    async def delete_tombstones_of_revoked_devices(self) -> None:
        """Tombstones never expire by age (a device may replay a queue after
        any time offline); they go when their device is revoked or deleted."""
        await self.db.execute(
            delete(AgentSessionTombstone)
            .where(
                AgentSessionTombstone.installation_id.in_(
                    select(CompanionInstallation.id).where(
                        CompanionInstallation.revoked_at.is_not(None)
                    )
                )
            )
            .execution_options(synchronize_session=False)
        )

    async def delete_links_to_missing_work(self, limit: int) -> int:
        """Links are filtered at read time; this only stops dead rows piling
        up. Deletes at most `limit`; returns how many it deleted."""
        card_exists = select(Card.id).where(Card.id == SessionWorkLink.entity_id)
        note_exists = select(Note.id).where(Note.id == SessionWorkLink.entity_id)
        dead = list(
            await self.db.scalars(
                select(SessionWorkLink.id)
                .where(
                    or_(
                        and_(
                            SessionWorkLink.entity_type == "card", ~card_exists.exists()
                        ),
                        and_(
                            SessionWorkLink.entity_type == "note", ~note_exists.exists()
                        ),
                    )
                )
                .limit(limit)
            )
        )
        if dead:
            await self.db.execute(
                delete(SessionWorkLink)
                .where(SessionWorkLink.id.in_(dead))
                .execution_options(synchronize_session=False)
            )
        return len(dead)
