# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Integer,
    String,
    and_,
    case,
    cast,
    false,
    func,
    literal,
    literal_column,
    or_,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.models.agent_session import (
    NON_ACTIVITY_ACTIONS,
    AgentSessionEvent,
    AgentSessionInvocation,
)
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.mcp_invocation import MCPConsultation, MCPInvocation
from app.models.notes.note import Note
from app.models.workspace import WorkspaceMember
from app.repositories.agent_session import epoch_seconds

PROMPT_ACTION = "prompt.submitted"
# Tool names that edit files, lowercased; the same set the web timeline tints
# as file work (frontend CallRow).
FILE_TOOL_PREFIXES = (
    "edit",
    "write",
    "multiedit",
    "multi_edit",
    "applypatch",
    "apply_patch",
    "notebookedit",
    "notebook_edit",
    "str_replace",
)
REASONING_ACTION = "agent.reasoning"
# Activity rows and consultations of a person's own (non-agent) invocations.
HUMAN_PRINCIPAL = ""

Event = AgentSessionEvent

# Every event of one tool call shares its native call id; any other event is
# its own entry. The prefixes keep the two id spaces apart.
CALL_PREFIX = "c:"
EVENT_PREFIX = "e:"
# Inline literals, not bind parameters: PostgreSQL must see the SELECT and
# GROUP BY copies of this expression as the same expression.
anchor_of_event = case(
    (
        Event.native_tool_call_id.is_not(None),
        literal_column(f"'{CALL_PREFIX}'", String) + Event.native_tool_call_id,
    ),
    else_=literal_column(f"'{EVENT_PREFIX}'", String) + Event.event_id,
)
# Session lifecycle, usage, reasoning and heartbeats are not timeline entries.
is_timeline_event = or_(
    Event.native_tool_call_id.is_not(None),
    Event.action == PROMPT_ACTION,
    Event.tool_name.is_not(None),
    Event.mcp_tool.is_not(None),
)
# Mirrors app.core.codex_tool_result: only these harnesses and this marker
# carry a native Codex result.
CODEX_HARNESSES = ("codex_cli", "codex_desktop")
CODEX_RESULT_MARKER = "codex.tool_result"


def event_failed(dialect_name: str, session_id: uuid.UUID):
    """Whether one event failed, as the call display reads it: a nonempty
    indexed outcome wins; otherwise a retained Codex result whose success is
    boolean false or the exact string "false" (never numeric 0)."""
    legacy = Event.__table__.alias("legacy_outcomes")
    payload = legacy.c.event
    harness_name = payload[("harness", "name")].as_string()
    marker = payload[("raw", "attributes", "event.name")].as_string()
    success_path = ("raw", "attributes", "success")
    if dialect_name == "postgresql":
        attributes_are_object = (
            func.jsonb_typeof(payload[("raw", "attributes")]) == "object"
        )
        # ->> renders only boolean false and the string "false" as 'false';
        # missing keys and non-object containers yield NULL, never an error.
        said_false = payload[success_path].as_string() == "false"
    else:
        attributes_are_object = (
            func.json_type(payload, '$."raw"."attributes"') == "object"
        )
        # SQLite extracts boolean false as integer 0, so the JSON type tells
        # it apart from a numeric 0; the string "false" extracts as text.
        said_false = or_(
            func.json_type(payload, '$."raw"."attributes"."success"') == "false",
            payload[success_path].as_string() == "false",
        )
    legacy_failure = and_(
        or_(legacy.c.outcome.is_(None), legacy.c.outcome == ""),
        harness_name.in_(CODEX_HARNESSES),
        attributes_are_object,
        marker == CODEX_RESULT_MARKER,
        said_false,
    )
    # Keep retained JSON out of the surrounding aggregate's input.
    failed_legacy_ids = select(legacy.c.id).where(
        legacy.c.session_id == session_id, legacy_failure
    )
    return or_(Event.outcome == "failed", Event.id.in_(failed_legacy_ids))


@dataclass(frozen=True)
class CallGroup:
    anchor: str
    first_at: datetime
    last_at: datetime


@dataclass(frozen=True)
class TurnTotals:
    turn_index: int
    started_at: datetime
    ended_at: datetime
    call_count: int
    failure_count: int
    reasoning_count: int


@dataclass(frozen=True)
class CallWorkRow:
    call_id: str
    provenance: str
    workspace_id: uuid.UUID
    entity_type: str
    entity_id: uuid.UUID
    relation: str


@dataclass(frozen=True)
class WorkEntity:
    workspace_id: uuid.UUID
    board_id: uuid.UUID | None
    title: str


class SessionCallRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def groups_before(
        self,
        session_id: uuid.UUID,
        *,
        before: tuple[datetime, str] | None,
        anchors: set[str] | None,
        failed_only: bool,
        limit: int,
    ) -> list[CallGroup]:
        """The newest `limit` timeline entries strictly before `before`, newest
        first, keyed on (first occurrence, anchor) so a call never straddles
        two pages."""
        # Perf: LIMIT applies after grouping, so every page aggregates all of
        # the session's events (turn_totals likewise scans its turns' range).
        # Fine at today's sizes; past ~20k events, materialize call groups at
        # ingest instead (follow-up to DK-WEB B4).
        first_at = func.min(Event.occurred_at)
        query = (
            select(
                anchor_of_event.label("anchor"),
                first_at.label("first_at"),
                func.max(Event.occurred_at).label("last_at"),
            )
            .where(Event.session_id == session_id, is_timeline_event)
            .group_by(anchor_of_event)
        )
        if anchors is not None:
            query = query.where(anchor_of_event.in_(anchors))
        if failed_only:
            query = query.having(
                func.max(case((self._event_failed(session_id), 1), else_=0)) == 1
            )
        if before is not None:
            before_at, before_anchor = before
            query = query.having(
                or_(
                    first_at < before_at,
                    and_(first_at == before_at, anchor_of_event < before_anchor),
                )
            )
        rows = await self.db.execute(
            query.order_by(first_at.desc(), anchor_of_event.desc()).limit(limit)
        )
        return [CallGroup(row.anchor, row.first_at, row.last_at) for row in rows]

    async def events_of(
        self, session_id: uuid.UUID, anchors: set[str]
    ) -> list[AgentSessionEvent]:
        call_ids = {
            a.removeprefix(CALL_PREFIX) for a in anchors if a.startswith(CALL_PREFIX)
        }
        event_ids = {
            a.removeprefix(EVENT_PREFIX) for a in anchors if a.startswith(EVENT_PREFIX)
        }
        if not call_ids and not event_ids:
            return []
        # The id columns themselves, not the anchor expression, so the native
        # call and (session, event id) indexes serve the lookup.
        result = await self.db.scalars(
            select(Event)
            .where(
                Event.session_id == session_id,
                or_(
                    Event.native_tool_call_id.in_(call_ids),
                    and_(
                        Event.native_tool_call_id.is_(None),
                        Event.event_id.in_(event_ids),
                    ),
                ),
            )
            .order_by(Event.occurred_at, Event.id)
        )
        return list(result)

    async def prompt_times(self, session_id: uuid.UUID) -> list[tuple[datetime, str]]:
        """(occurred_at, event_id) of every prompt, in turn order."""
        result = await self.db.execute(
            select(Event.occurred_at, Event.event_id)
            .where(Event.session_id == session_id, Event.action == PROMPT_ACTION)
            .order_by(Event.occurred_at, Event.event_id)
        )
        return list(result.tuples())

    async def turn_totals(
        self,
        session_id: uuid.UUID,
        turn_starts: dict[int, datetime | None],
        turn_ends: datetime | None,
    ) -> list[TurnTotals]:
        """Totals of the given turns, each entry counted in the turn of its
        first event. `turn_starts` maps each turn to where it opens (None:
        the session's start); `turn_ends` is where the last one closes."""
        if not turn_starts:
            return []
        entries = (
            select(
                anchor_of_event.label("anchor"),
                func.min(Event.occurred_at).label("first_at"),
                func.max(Event.occurred_at).label("last_at"),
                func.max(case((is_timeline_event, 1), else_=0)).label("listed"),
                func.max(case((Event.action == PROMPT_ACTION, 1), else_=0)).label(
                    "prompt"
                ),
                func.max(case((self._event_failed(session_id), 1), else_=0)).label(
                    "failed"
                ),
                func.max(case((Event.action == REASONING_ACTION, 1), else_=0)).label(
                    "reasoning"
                ),
            )
            .where(Event.session_id == session_id)
            .group_by(anchor_of_event)
        )
        first_turn = min(turn_starts)
        if turn_starts[first_turn] is not None:
            entries = entries.having(
                func.min(Event.occurred_at) >= turn_starts[first_turn]
            )
        if turn_ends is not None:
            entries = entries.having(func.min(Event.occurred_at) < turn_ends)
        entries = entries.subquery()
        opened = [
            (turn, start)
            for turn, start in sorted(turn_starts.items(), reverse=True)
            if start is not None and turn != first_turn
        ]
        turn_of_entry = (
            case(
                *[(entries.c.first_at >= start, turn) for turn, start in opened],
                else_=first_turn,
            )
            if opened
            else literal_column(str(first_turn))
        )
        # Grouped through a subquery column: the CASE carries bind parameters,
        # which PostgreSQL would not match between SELECT and GROUP BY.
        is_call = and_(entries.c.listed == 1, entries.c.prompt == 0)
        turned = select(
            turn_of_entry.label("turn_index"),
            entries.c.first_at,
            entries.c.last_at,
            case((is_call, 1), else_=0).label("is_call"),
            case((and_(is_call, entries.c.failed == 1), 1), else_=0).label("failed"),
            entries.c.reasoning,
        ).subquery()
        rows = await self.db.execute(
            select(
                turned.c.turn_index,
                func.min(turned.c.first_at).label("started_at"),
                func.max(turned.c.last_at).label("ended_at"),
                func.sum(turned.c.is_call).label("call_count"),
                func.sum(turned.c.failed).label("failure_count"),
                func.sum(turned.c.reasoning).label("reasoning_count"),
            ).group_by(turned.c.turn_index)
        )
        return [
            TurnTotals(
                turn_index=row.turn_index,
                started_at=row.started_at,
                ended_at=row.ended_at,
                call_count=row.call_count or 0,
                failure_count=row.failure_count or 0,
                reasoning_count=row.reasoning_count or 0,
            )
            for row in rows
        ]

    async def call_work(
        self, session_id: uuid.UUID, owner_id: uuid.UUID
    ) -> list[CallWorkRow]:
        """What each matched MCP call of the session changed (server-recorded
        Activity) or consulted, in workspaces the owner still belongs to."""
        member_of = select(WorkspaceMember.workspace_id).where(
            WorkspaceMember.user_id == owner_id
        )
        call_id = func.coalesce(
            AgentSessionInvocation.matched_call_id, MCPInvocation.native_call_id
        )
        matched = (
            select(
                call_id.label("call_id"),
                AgentSessionInvocation.provenance,
                AgentSessionInvocation.invocation_id,
            )
            .join(
                MCPInvocation, MCPInvocation.id == AgentSessionInvocation.invocation_id
            )
            .where(
                AgentSessionInvocation.session_id == session_id, call_id.is_not(None)
            )
            .subquery()
        )
        changed = await self.db.execute(
            select(
                matched.c.call_id,
                matched.c.provenance,
                Activity.workspace_id,
                Activity.entity_type,
                Activity.entity_id,
            )
            .join(Activity, Activity.mcp_invocation_id == matched.c.invocation_id)
            .where(
                Activity.actor_id == owner_id,
                Activity.principal_key == HUMAN_PRINCIPAL,
                Activity.entity_type.in_(["card", "note"]),
                Activity.workspace_id.in_(member_of),
            )
            .distinct()
        )
        consulted = await self.db.execute(
            select(
                matched.c.call_id,
                matched.c.provenance,
                MCPConsultation.workspace_id,
                MCPConsultation.entity_type,
                MCPConsultation.entity_id,
            )
            .join(
                MCPConsultation,
                MCPConsultation.invocation_id == matched.c.invocation_id,
            )
            .where(
                MCPConsultation.actor_id == owner_id,
                MCPConsultation.principal_key == HUMAN_PRINCIPAL,
                MCPConsultation.workspace_id.in_(member_of),
            )
        )
        return [
            CallWorkRow(
                call_id=row[0],
                provenance=row[1],
                workspace_id=row[2],
                entity_type=str(getattr(row[3], "value", row[3])),
                entity_id=row[4],
                relation=relation,
            )
            for relation, rows in (("changed", changed), ("consulted", consulted))
            for row in rows
        ]

    def _event_failed(self, session_id: uuid.UUID):
        return event_failed(self.db.get_bind().dialect.name, session_id)

    def _epoch_ms(self, column):
        return func.round(epoch_seconds(self.db.get_bind().dialect.name, column) * 1000)

    def _whole(self, value):
        if self.db.get_bind().dialect.name == "postgresql":
            return cast(func.floor(value), Integer)
        # Truncates toward zero; only entries before the start go negative,
        # and the caller clamps those into the first bucket anyway.
        return cast(value, Integer)

    async def rhythm_counts(
        self,
        session_id: uuid.UUID,
        *,
        start: datetime,
        bucket_ms: float,
        work_call_ids: set[str],
    ) -> list[tuple[int, str, int]]:
        """(bucket index, kind, entries) for every timeline entry, bucketed by
        its first event; indexes past either end are the caller's to clamp.
        Kinds follow RhythmBucket's precedence."""
        file_tool = or_(
            *(
                func.lower(Event.tool_name).like(
                    prefix.replace("_", "\\_") + "%", escape="\\"
                )
                for prefix in FILE_TOOL_PREFIXES
            )
        )
        touched_work = (
            Event.native_tool_call_id.in_(work_call_ids) if work_call_ids else false()
        )
        entries = (
            select(
                func.min(Event.occurred_at).label("first_at"),
                func.max(case((Event.action == PROMPT_ACTION, 1), else_=0)).label(
                    "prompt"
                ),
                func.max(case((self._event_failed(session_id), 1), else_=0)).label(
                    "failed"
                ),
                func.max(case((touched_work, 1), else_=0)).label("work"),
                func.max(case((file_tool, 1), else_=0)).label("file"),
            )
            .where(Event.session_id == session_id, is_timeline_event)
            .group_by(anchor_of_event)
            .subquery()
        )
        start_ms = self._epoch_ms(literal(start, DateTime(timezone=True)))
        # Grouped through a subquery column: the CASE and the arithmetic carry
        # bind parameters, which PostgreSQL would not match in a GROUP BY.
        classified = select(
            self._whole(
                (self._epoch_ms(entries.c.first_at) - start_ms) / bucket_ms
            ).label("bucket"),
            case(
                (entries.c.prompt == 1, "prompt"),
                (entries.c.failed == 1, "error"),
                (entries.c.work == 1, "work"),
                (entries.c.file == 1, "file"),
                else_="tool",
            ).label("kind"),
        ).subquery()
        rows = await self.db.execute(
            select(classified.c.bucket, classified.c.kind, func.count()).group_by(
                classified.c.bucket, classified.c.kind
            )
        )
        return [(int(bucket), kind, entries) for bucket, kind, entries in rows]

    async def silences(
        self, session_id: uuid.UUID, longer_than_ms: int
    ) -> list[tuple[datetime, datetime]]:
        """Gaps between consecutive activity events longer than the bound."""
        activity = (
            select(
                Event.occurred_at.label("at"),
                func.lag(Event.occurred_at, type_=DateTime(timezone=True))
                .over(order_by=(Event.occurred_at, Event.id))
                .label("previous"),
            )
            .where(
                Event.session_id == session_id,
                Event.action.not_in(NON_ACTIVITY_ACTIONS),
            )
            .subquery()
        )
        gap_ms = self._epoch_ms(activity.c.at) - self._epoch_ms(activity.c.previous)
        rows = await self.db.execute(
            select(activity.c.previous, activity.c.at)
            .where(activity.c.previous.is_not(None), gap_ms > longer_than_ms)
            .order_by(activity.c.previous)
        )
        return list(rows.tuples())

    async def live_cards(self, card_ids: set[uuid.UUID]) -> dict[uuid.UUID, WorkEntity]:
        if not card_ids:
            return {}
        rows = await self.db.execute(
            select(Card.id, Card.title, Card.board_id, Board.workspace_id)
            .join(Board, Card.board_id == Board.id)
            .where(Card.id.in_(card_ids))
        )
        return {
            row.id: WorkEntity(row.workspace_id, row.board_id, row.title)
            for row in rows
        }

    async def live_notes(self, note_ids: set[uuid.UUID]) -> dict[uuid.UUID, WorkEntity]:
        if not note_ids:
            return {}
        rows = await self.db.execute(
            select(Note.id, Note.title, Note.board_id, Note.workspace_id).where(
                Note.id.in_(note_ids)
            )
        )
        return {
            row.id: WorkEntity(row.workspace_id, row.board_id, row.title)
            for row in rows
        }
