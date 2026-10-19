# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import binascii
import json
import uuid
from bisect import bisect_right
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.codex_tool_result import codex_tool_result
from app.core.time import as_utc
from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.agent_session import AgentSession, AgentSessionEvent
from app.repositories.session_calls import (
    CALL_PREFIX,
    EVENT_PREFIX,
    PROMPT_ACTION,
    CallGroup,
    SessionCallRepository,
)
from app.schemas.agent_session import (
    AgentSessionRead,
    CallWorkRef,
    SessionCallDetail,
    SessionCallItem,
    SessionCallPage,
    SessionTurn,
    WithheldContent,
)
from app.services.agent_session import (
    AgentSessionService,
    event_read,
    lifecycle_status,
)
from app.services.session_call_content import (
    argument_preview,
    exit_code,
    prompt_preview,
    reported_duration_ms,
    sends_output,
    withheld_content,
)

SUBAGENT_PREFIX = "s:"


def encode_call_cursor(at: datetime, anchor: str) -> str:
    raw = json.dumps([as_utc(at).isoformat(), anchor]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_call_cursor(cursor: str | None) -> tuple[datetime, str] | None:
    if cursor is None:
        return None
    try:
        at, anchor = json.loads(
            base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4))
        )
        if not isinstance(anchor, str):
            raise TypeError
        return as_utc(datetime.fromisoformat(at)), anchor
    except (ValueError, TypeError, binascii.Error):
        raise ValidationError("Invalid cursor") from None


def call_key(anchor: str) -> str:
    return base64.urlsafe_b64encode(anchor.encode()).decode().rstrip("=")


def anchor_of_key(key: str) -> str | None:
    try:
        anchor = base64.urlsafe_b64decode(key + "=" * (-len(key) % 4)).decode()
    except (ValueError, binascii.Error):
        return None
    return anchor if anchor.startswith((CALL_PREFIX, EVENT_PREFIX)) else None


def _outcome(events: list[AgentSessionEvent], session_open: bool) -> str:
    """Only a completion signal (a .completed/.failed action, an exit code, an
    error) settles a call; more events of it are not one, since several hooks
    can fire before a call returns."""
    outcomes = {
        event.outcome
        or (native.outcome if (native := codex_tool_result(event.event)) else None)
        for event in events
    }
    if "failed" in outcomes:
        return "failed"
    if "succeeded" in outcomes:
        return "succeeded"
    return "running" if session_open else "unknown"


def _call_item(
    anchor: str,
    events: list[AgentSessionEvent],
    turn_index: int,
    work_refs: list[CallWorkRef],
    session_open: bool,
) -> SessionCallItem:
    first, last = events[0], events[-1]
    is_prompt = any(event.action == PROMPT_ACTION for event in events)
    native_results = [codex_tool_result(event.event) for event in events]
    names = [event.tool_name for event in events if event.tool_name]
    mcp_tools = [
        name
        for event, native in zip(events, native_results)
        if (name := event.mcp_tool or (native.mcp_tool if native else None))
    ]
    mcp_servers = [
        name
        for event, native in zip(events, native_results)
        if (name := event.mcp_server or (native.mcp_server if native else None))
    ]
    is_mcp = bool(mcp_tools or mcp_servers)
    withheld = withheld_content(event.event for event in events)
    if len(events) > 1:
        duration_ms = round(
            (as_utc(last.occurred_at) - as_utc(first.occurred_at)).total_seconds()
            * 1000
        )
    else:
        duration_ms = reported_duration_ms(first.event)
    exit_codes = [
        code for event in events if (code := exit_code(event.event)) is not None
    ]
    if any(sends_output(event.event) for event in events):
        output = "sent"
    elif "output" in withheld:
        output = "withheld"
    else:
        output = "none"
    return SessionCallItem(
        key=call_key(anchor),
        kind="prompt" if is_prompt else "mcp" if is_mcp else "tool",
        turn_index=turn_index,
        call_id=first.native_tool_call_id,
        name=None if is_prompt else (names or mcp_tools or [first.action])[0],
        mcp_server=mcp_servers[0] if mcp_servers else None,
        mcp_tool=mcp_tools[0] if mcp_tools else None,
        started_at=first.occurred_at,
        ended_at=last.occurred_at,
        duration_ms=duration_ms,
        event_count=len(events),
        outcome=None if is_prompt else _outcome(events, session_open),
        exit_code=exit_codes[-1] if exit_codes else None,
        args_preview=next(
            (preview for event in events if (preview := argument_preview(event.event))),
            None,
        ),
        prompt_preview=next(
            (preview for event in events if (preview := prompt_preview(event.event))),
            None,
        ),
        output=output,
        withheld=[
            WithheldContent(field=field, bytes=size)
            for field, size in sorted(withheld.items())
        ],
        work_refs=work_refs,
        subagent=None,
    )


def _subagent_item(read: AgentSessionRead, turn_index: int) -> SessionCallItem:
    return SessionCallItem(
        key=call_key(SUBAGENT_PREFIX + str(read.id)),
        kind="subagent",
        turn_index=turn_index,
        call_id=None,
        name=read.title,
        mcp_server=None,
        mcp_tool=None,
        started_at=read.started_at,
        ended_at=read.last_event_at,
        duration_ms=round(
            (as_utc(read.last_event_at) - as_utc(read.started_at)).total_seconds()
            * 1000
        ),
        event_count=read.event_count,
        outcome=None,
        exit_code=None,
        args_preview=None,
        prompt_preview=None,
        output="none",
        withheld=[],
        work_refs=[],
        subagent=read,
    )


class SessionCallService(AgentSessionService):
    """A session's timeline as calls and turns, for its owner only. Content
    is only ever what the session's capture level stored at ingest."""

    def __init__(self, db: AsyncSession):
        super().__init__(db)
        self.calls = SessionCallRepository(db)

    async def list_calls(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        *,
        call_filter: str = "all",
        cursor: str | None = None,
        limit: int = 100,
    ) -> SessionCallPage:
        session = await self._owned(workspace_id, owner_id, session_id)
        before = decode_call_cursor(cursor)
        refs_by_call = await self._work_refs(session)
        work_anchors = (
            {CALL_PREFIX + call_id for call_id in refs_by_call}
            if call_filter == "work"
            else None
        )
        groups = (
            []
            if work_anchors == set()
            else await self.calls.groups_before(
                session.id,
                before=before,
                anchors=work_anchors,
                failed_only=call_filter == "failures",
                limit=limit + 1,
            )
        )
        subagents = (
            await self._subagents_before(session, owner_id, before)
            if call_filter == "all"
            else []
        )
        entries: list[tuple[datetime, str, CallGroup | AgentSessionRead]] = [
            (as_utc(group.first_at), group.anchor, group) for group in groups
        ] + [
            (as_utc(read.started_at), SUBAGENT_PREFIX + str(read.id), read)
            for read in subagents
        ]
        entries.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
        page = entries[:limit]
        next_cursor = (
            encode_call_cursor(page[-1][0], page[-1][1])
            if len(entries) > limit
            else None
        )
        page.reverse()

        prompts = await self.calls.prompt_times(session.id)
        prompt_starts = [as_utc(at) for at, _ in prompts]
        prompt_turn = {
            EVENT_PREFIX + event_id: index
            for index, (_, event_id) in enumerate(prompts, 1)
        }
        events = await self.calls.events_of(
            session.id,
            {anchor for _, anchor, entry in page if isinstance(entry, CallGroup)},
        )
        events_by_anchor: dict[str, list[AgentSessionEvent]] = {}
        for event in events:
            anchor = (
                CALL_PREFIX + event.native_tool_call_id
                if event.native_tool_call_id
                else EVENT_PREFIX + event.event_id
            )
            events_by_anchor.setdefault(anchor, []).append(event)

        session_open = lifecycle_status(session, datetime.now(timezone.utc)) != "ended"
        items = []
        for first_at, anchor, entry in page:
            turn_index = prompt_turn.get(anchor, bisect_right(prompt_starts, first_at))
            if isinstance(entry, CallGroup):
                call_events = events_by_anchor.get(anchor)
                if not call_events:
                    continue
                call_id = call_events[0].native_tool_call_id
                items.append(
                    _call_item(
                        anchor,
                        call_events,
                        turn_index,
                        refs_by_call.get(call_id, []) if call_id else [],
                        session_open,
                    )
                )
            else:
                items.append(_subagent_item(entry, turn_index))
        return SessionCallPage(
            items=items,
            turns=await self._turns(session.id, items, prompt_starts),
            next_cursor=next_cursor,
        )

    async def get_call(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        key: str,
    ) -> SessionCallDetail:
        session = await self._owned(workspace_id, owner_id, session_id)
        anchor = anchor_of_key(key)
        events = await self.calls.events_of(session.id, {anchor}) if anchor else []
        if not events:
            raise ResourceNotFoundError("Call not found")
        levels = await self.repo.capture_content_levels(
            session.installation_id, {event.capture_id for event in events}
        )
        return SessionCallDetail(
            key=key,
            events=[
                event_read(event, levels.get(event.capture_id)) for event in events
            ],
        )

    async def _subagents_before(
        self,
        session: AgentSession,
        owner_id: uuid.UUID,
        before: tuple[datetime, str] | None,
    ) -> list[AgentSessionRead]:
        children = await self.repo.owned_children(
            session.workspace_id, owner_id, session.id
        )
        if before is not None:
            children = [
                child
                for child in children
                if (as_utc(child.started_at), SUBAGENT_PREFIX + str(child.id)) < before
            ]
        return await self._reads(children)

    async def _turns(
        self,
        session_id: uuid.UUID,
        items: list[SessionCallItem],
        prompt_starts: list[datetime],
    ) -> list[SessionTurn]:
        if not items:
            return []
        first_turn = min(item.turn_index for item in items)
        last_turn = max(item.turn_index for item in items)
        starts = {
            turn: prompt_starts[turn - 1] if turn else None
            for turn in range(first_turn, last_turn + 1)
        }
        totals = await self.calls.turn_totals(
            session_id,
            starts,
            prompt_starts[last_turn] if last_turn < len(prompt_starts) else None,
        )
        on_page = {item.turn_index for item in items}
        return [
            SessionTurn(
                turn_index=total.turn_index,
                started_at=total.started_at,
                ended_at=total.ended_at,
                call_count=total.call_count,
                failure_count=total.failure_count,
                reasoning_count=total.reasoning_count,
            )
            for total in sorted(totals, key=lambda total: total.turn_index)
            if total.turn_index in on_page
        ]

    async def work_call_ids(self, session: AgentSession) -> set[str]:
        """Native ids of the calls whose linked work the owner can see now."""
        refs_by_call = await self._work_refs(session)
        return {call_id for call_id, refs in refs_by_call.items() if refs}

    async def _work_refs(self, session: AgentSession) -> dict[str, list[CallWorkRef]]:
        """Per native call id, the cards and notes it touched that still exist
        in a workspace the owner belongs to (the rule of `_visible_links`)."""
        rows = await self.calls.call_work(session.id, session.owner_id)
        cards = await self.calls.live_cards(
            {row.entity_id for row in rows if row.entity_type == "card"}
        )
        notes = await self.calls.live_notes(
            {row.entity_id for row in rows if row.entity_type == "note"}
        )
        refs: dict[str, dict[tuple, CallWorkRef]] = {}
        for row in rows:
            entity = (cards if row.entity_type == "card" else notes).get(row.entity_id)
            if entity is None or entity.workspace_id != row.workspace_id:
                continue
            ref_key = (row.entity_type, row.entity_id, row.relation)
            known = refs.setdefault(row.call_id, {}).get(ref_key)
            refs[row.call_id][ref_key] = CallWorkRef(
                entity_type=row.entity_type,
                entity_id=row.entity_id,
                workspace_id=row.workspace_id,
                board_id=entity.board_id,
                title=entity.title,
                relation=row.relation,
                # Exact wins when one call's work was matched both ways.
                provenance="exact"
                if row.provenance == "exact" or (known and known.provenance == "exact")
                else "correlated",
            )
        return {
            call_id: sorted(
                by_key.values(),
                key=lambda ref: (ref.relation, ref.entity_type, str(ref.entity_id)),
            )
            for call_id, by_key in refs.items()
        }
