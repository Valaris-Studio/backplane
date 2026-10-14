# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import json
import uuid
from collections.abc import Iterable
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id
from app.core.harness import HARNESS_FAMILIES, harness_display_name, harness_enabled
from app.core.time import as_utc
from app.core.working_directory import (
    without_device_path,
    without_device_working_directories,
)
from app.exceptions import ForbiddenError, ResourceNotFoundError, ValidationError
from app.models.agent_session import AgentSession, AgentSessionEvent
from app.models.companion import CompanionInstallation
from app.repositories.agent_session import (
    MAX_THREAD_DEPTH,
    AgentSessionRepository,
    CaptureSwitches,
)
from app.schemas.agent_session import (
    AgentSessionEventPage,
    AgentSessionEventRead,
    AgentSessionPage,
    AgentSessionList,
    AgentSessionRead,
    LinkedSessionList,
    LinkedSessionRead,
    LinkedWorkSummary,
    SessionLinkPreview,
    SessionModelUsage,
    SessionPeriodSummary,
    SessionUsageList,
    SessionWorkLinkList,
    SessionWorkLinkRead,
)
from app.pricing import current_price_table
from app.repositories.agent_session_usage import AgentSessionUsageRepository
from app.services.agent_usage import (
    SPEND_AUTH_KINDS,
    linked_cost_fields,
    model_usage_fields,
    session_cost_fields,
)
from app.services.session_events import Invalidation, session_updated
from app.services.session_history_cutoff import history_cutoffs
from app.services.storage.session_content import content_store

# Silence is not an ending: agents think for minutes between tool calls.
IDLE_AFTER = timedelta(minutes=15)
# A session silent this long, without an end event, is not coming back.
ABANDONED_AFTER = timedelta(hours=24)
# A device that has not reported for this long is offline or cut off.
HEARTBEAT_STALE_AFTER = timedelta(minutes=30)


def encode_cursor(at: datetime, row_id: uuid.UUID) -> str:
    raw = json.dumps([as_utc(at).isoformat(), str(row_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str | None) -> tuple[datetime, uuid.UUID] | None:
    if cursor is None:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        at, row_id = json.loads(base64.urlsafe_b64decode(padded))
        return as_utc(datetime.fromisoformat(at)), uuid.UUID(row_id)
    except (ValueError, TypeError):
        raise ValidationError("Invalid cursor") from None


# Rows previewed per session in the list.
LINK_PREVIEW_SIZE = 2


def encode_list_cursor(sort: str, key, row_id: uuid.UUID) -> str:
    """`recent` keeps the previous release's two-element cursor, so a page
    opened before a rolling deploy still continues; every other sort names
    itself, so a cursor never continues a different order."""
    if sort == "recent":
        return encode_cursor(key, row_id)
    value = as_utc(key).isoformat() if isinstance(key, datetime) else key
    raw = json.dumps([sort, value, str(row_id)]).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_list_cursor(
    sort: str, cursor: str | None
) -> tuple[object, uuid.UUID] | None:
    if cursor is None:
        return None
    if sort == "recent":
        return decode_cursor(cursor)
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        cursor_sort, value, row_id = json.loads(base64.urlsafe_b64decode(padded))
        if cursor_sort != sort:
            raise ValueError
        if sort == "started":
            key = as_utc(datetime.fromisoformat(value))
        elif value is None and sort == "cost":
            key = None
        elif isinstance(value, int) and not isinstance(value, bool):
            key = value
        else:
            raise ValueError
        return key, uuid.UUID(row_id)
    except (ValueError, TypeError):
        raise ValidationError("Invalid cursor") from None


def _money_total(value) -> float | None:
    # SQLite sums Numeric as float; going through str keeps PostgreSQL's
    # Decimal exact and rounds a float sum to its shortest repr.
    return None if value is None else float(Decimal(str(value)))


def capture_switches(
    installations: list[CompanionInstallation], now: datetime
) -> CaptureSwitches:
    """The device half of display_state, per installation, for SQL filters."""
    switches = CaptureSwitches()
    for installation in installations:
        if installation.paused:
            switches.paused.add(installation.id)
        else:
            enabled = installation.enabled_agents or []
            switches.capturing_harnesses[installation.id] = {
                harness
                for harness in set(enabled) | set(HARNESS_FAMILIES)
                if harness_enabled(harness, enabled)
            }
        if (
            installation.revoked_at is not None
            or installation.last_seen_at is None
            or now - as_utc(installation.last_seen_at) > HEARTBEAT_STALE_AFTER
        ):
            switches.disconnected.add(installation.id)
    return switches


def lifecycle_status(session: AgentSession, now: datetime) -> str:
    """Active, idle or ended from the session's own timestamps, so a list can
    filter on it in SQL. Some sessions never send an end event (headless
    `codex exec`), so a silence past ABANDONED_AFTER ends them too; any new
    event makes them active again."""
    if session.status == "ended":
        return "ended"
    silent_for = now - as_utc(session.last_event_at)
    if silent_for > ABANDONED_AFTER:
        return "ended"
    return "idle" if silent_for > IDLE_AFTER else "active"


def display_state(
    session: AgentSession,
    installation: CompanionInstallation | None,
    mapping_disabled: bool,
    now: datetime,
) -> str:
    """Precedence: a real end, then capture
    switched off, then more than a day of silence, then an unreachable device,
    then idle or active. An ended session with capture gaps is `incomplete`:
    it finished, but its timeline has holes."""
    if session.ended_at is not None and as_utc(session.ended_at) >= as_utc(
        session.last_event_at
    ):
        return "incomplete" if session.capture_gaps else "ended"
    if installation is not None and (
        installation.paused
        or not harness_enabled(session.harness, installation.enabled_agents)
        or mapping_disabled
    ):
        return "paused"
    silent_for = now - as_utc(session.last_event_at)
    if silent_for > ABANDONED_AFTER:
        return "incomplete"
    # Only a session that would otherwise be active or idle is shown as cut
    # off by its device.
    if installation is not None and (
        installation.revoked_at is not None
        or installation.last_seen_at is None
        or now - as_utc(installation.last_seen_at) > HEARTBEAT_STALE_AFTER
    ):
        return "disconnected"
    return "active" if silent_for <= IDLE_AFTER else "idle"


def ended_reason(session: AgentSession, status: str) -> str | None:
    """Why an `ended` status ended; independent of what display_state shows."""
    if status != "ended":
        return None
    return "session_end_event" if session.status == "ended" else "abandoned"


def session_coverage(session: AgentSession, activity_events: int) -> str:
    if activity_events:
        return "activity"
    reported_usage = (
        session.input_tokens
        or session.output_tokens
        or session.cache_read_tokens
        or session.cache_creation_tokens
        or session.cost_usd is not None
    )
    return "usage_only" if reported_usage else "empty"


def session_read(
    session: AgentSession,
    installation: CompanionInstallation | None,
    mapping_disabled: bool,
    now: datetime,
    *,
    counted_activity_events: int,
    child_count: int | None = None,
    link_count: int | None = None,
    link_preview: list[SessionLinkPreview] | None = None,
) -> AgentSessionRead:
    """`counted_activity_events` is the count from stored events, used only
    when the session row carries none (written by the previous release)."""
    activity_events = session.activity_event_count
    if activity_events is None:
        activity_events = counted_activity_events
    status = lifecycle_status(session, now)
    reason = ended_reason(session, status)
    silent_since = as_utc(session.last_event_at)
    return AgentSessionRead(
        id=session.id,
        workspace_id=session.workspace_id,
        owner_id=session.owner_id,
        installation_id=session.installation_id,
        harness=session.harness,
        harness_display_name=harness_display_name(session.harness),
        native_session_id=session.native_session_id,
        parent_session_id=session.parent_session_id,
        mapping_id=session.mapping_id,
        board_id=session.board_id,
        status=status,
        display_state=display_state(session, installation, mapping_disabled, now),
        ended_reason=reason,
        idle_since=session.last_event_at
        if reason != "session_end_event" and now - silent_since > IDLE_AFTER
        else None,
        started_at=session.started_at,
        last_event_at=session.last_event_at,
        ended_at=session.ended_at,
        cwd=without_device_path(session.cwd),
        repository=session.repository,
        branch=session.branch,
        model=session.model,
        harness_version=session.harness_version,
        title=session.title,
        input_tokens=session.input_tokens,
        output_tokens=session.output_tokens,
        cache_read_tokens=session.cache_read_tokens,
        cache_creation_tokens=session.cache_creation_tokens,
        **session_cost_fields(session),
        event_count=session.event_count,
        prompt_count=session.prompt_count,
        tool_call_count=session.tool_call_count,
        error_count=session.error_count,
        capture_gaps=session.capture_gaps,
        activity_event_count=activity_events,
        coverage=session_coverage(session, activity_events),
        capture_levels=session.capture_levels or [],
        child_count=child_count,
        link_count=link_count,
        link_preview=link_preview,
    )


def union_seconds(intervals: Iterable[tuple[datetime, datetime]]) -> float:
    """Seconds covered by at least one interval; overlaps count once."""
    covered = 0.0
    run_start = run_end = None
    # Clamping end to start makes a reversed span (end before start) count as zero wall time.
    for start, end in sorted(
        (as_utc(s), max(as_utc(s), as_utc(e))) for s, e in intervals
    ):
        if run_end is None or start > run_end:
            if run_end is not None:
                covered += (run_end - run_start).total_seconds()
            run_start, run_end = start, end
        else:
            run_end = max(run_end, end)
    if run_end is not None:
        covered += (run_end - run_start).total_seconds()
    return covered


def linked_summary(
    sessions: list[AgentSession], seen_spans: Iterable[tuple[datetime, datetime]]
):
    """`seen_spans` are each session's first and last link to the entity."""
    spans = list(seen_spans)
    return LinkedWorkSummary(
        session_count=len(sessions),
        first_seen_at=min((first for first, _ in spans), default=None),
        last_seen_at=max((last for _, last in spans), default=None),
        total_duration_seconds=sum(
            (as_utc(s.last_event_at) - as_utc(s.started_at)).total_seconds()
            for s in sessions
        ),
        wall_duration_seconds=union_seconds(
            (s.started_at, s.last_event_at) for s in sessions
        ),
        input_tokens=sum(s.input_tokens for s in sessions),
        output_tokens=sum(s.output_tokens for s in sessions),
        cache_read_tokens=sum(s.cache_read_tokens for s in sessions),
        cache_creation_tokens=sum(s.cache_creation_tokens for s in sessions),
        **linked_cost_fields(sessions),
    )


def event_read(
    event: AgentSessionEvent, capture_level: str | None
) -> AgentSessionEventRead:
    return AgentSessionEventRead(
        id=event.id,
        event_id=event.event_id,
        capture_id=event.capture_id,
        occurred_at=event.occurred_at,
        received_at=event.received_at,
        action=event.action,
        kind=event.kind,
        category=event.category,
        fidelity=event.fidelity,
        collection_method=event.collection_method,
        tool_name=event.tool_name,
        native_tool_call_id=event.native_tool_call_id,
        mcp_server=event.mcp_server,
        mcp_tool=event.mcp_tool,
        outcome=event.outcome,
        capture_level=capture_level,
        data=without_device_working_directories(event.event),
    )


async def recount_next_session_activity(
    db: AsyncSession, after: uuid.UUID | None, *, only_unknown: bool = True
) -> uuid.UUID | None:
    """Recount the activity events of the first session past `after` (by id),
    only among uncounted ones unless `only_unknown` is False. Returns its id,
    or None when there is none left. Run one per transaction: each holds a
    single session lock, so it can never deadlock with ingest."""
    repo = AgentSessionRepository(db)
    session = await repo.lock_next_session(after, only_uncounted=only_unknown)
    if session is None:
        return None
    counts = await repo.activity_event_counts({session.id})
    session.activity_event_count = counts.get(session.id, 0)
    await db.flush()
    return session.id


class AgentSessionService:
    """Owner-private reads. A session is visible only to the person whose
    machine captured it, and only while they still belong to its workspace;
    no workspace role or card visibility widens that."""

    def __init__(self, db: AsyncSession):
        self.repo = AgentSessionRepository(db)
        self.usage = AgentSessionUsageRepository(db)

    async def _reads(
        self,
        sessions: list[AgentSession],
        now: datetime | None = None,
        *,
        with_work: bool = True,
    ) -> list[AgentSessionRead]:
        """`with_work` adds subagent and linked-work counts with card and note
        titles: for the owner's own reads, never for a device's."""
        installations = await self.repo.installations(
            {session.installation_id for session in sessions}
        )
        disabled = await self.repo.disabled_mappings(
            {session.mapping_id for session in sessions if session.mapping_id}
        )
        counted = await self.repo.activity_event_counts(
            {session.id for session in sessions if session.activity_event_count is None}
        )
        children: dict[uuid.UUID, int] = {}
        previews: dict = {}
        if with_work and sessions:
            owner_id = sessions[0].owner_id
            ids = {session.id for session in sessions}
            children = await self.repo.child_counts(owner_id, ids)
            previews = await self.repo.link_previews(owner_id, ids, LINK_PREVIEW_SIZE)
        now = now or datetime.now(timezone.utc)
        reads = []
        for session in sessions:
            work = {}
            if with_work:
                link_count, preview = previews.get(session.id, (0, []))
                work = {
                    "child_count": children.get(session.id, 0),
                    "link_count": link_count,
                    "link_preview": [
                        SessionLinkPreview.model_validate(row, from_attributes=True)
                        for row in preview
                    ],
                }
            reads.append(
                session_read(
                    session,
                    installations.get(session.installation_id),
                    session.mapping_id in disabled,
                    now,
                    counted_activity_events=counted.get(session.id, 0),
                    **work,
                )
            )
        return reads

    async def _authorize(self, workspace_id: uuid.UUID, owner_id: uuid.UUID) -> None:
        # An agent key resolves to its creator; it must never inherit that
        # person's private sessions.
        if current_agent_id.get() is not None:
            raise ForbiddenError("Agent keys cannot read captured sessions")
        if not await self.repo.is_member(workspace_id, owner_id):
            raise ForbiddenError("Not a member of this workspace")

    async def _owned(self, workspace_id, owner_id, session_id) -> AgentSession:
        await self._authorize(workspace_id, owner_id)
        session = await self.repo.get_owned(workspace_id, owner_id, session_id)
        if session is None:
            raise ResourceNotFoundError("Session not found")
        return session

    async def list_sessions(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        board_id: uuid.UUID | None = None,
        harness: str | None = None,
        status: str | None = None,
        states: list[str] | None = None,
        q: str | None = None,
        linked_only: bool = False,
        since: datetime | None = None,
        root_only: bool = False,
        sort: str = "recent",
        cursor: str | None = None,
        limit: int = 50,
    ) -> AgentSessionPage:
        await self._authorize(workspace_id, owner_id)
        after = decode_list_cursor(sort, cursor)
        now = datetime.now(timezone.utc)
        switches = (
            capture_switches(await self.repo.owner_installations(owner_id), now)
            if states
            else CaptureSwitches()
        )
        rows = await self.repo.list_owned(
            workspace_id,
            owner_id,
            board_id=board_id,
            harness=harness,
            status=status,
            states=states,
            switches=switches,
            q=(q or "").strip() or None,
            linked_only=linked_only,
            since=as_utc(since) if since else None,
            idle_before=now - IDLE_AFTER,
            abandoned_before=now - ABANDONED_AFTER,
            root_only=root_only,
            sort=sort,
            after=after,
            limit=limit + 1,
        )
        page = [session for session, _ in rows[:limit]]
        last_session, last_key = rows[limit - 1] if len(rows) > limit else (None, None)
        return AgentSessionPage(
            # The same clock as the filter, so every item reads the state it
            # was filtered by.
            items=await self._reads(page, now),
            next_cursor=encode_list_cursor(sort, last_key, last_session.id)
            if last_session is not None
            else None,
        )

    async def period_summary(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        *,
        board_id: uuid.UUID | None = None,
        harness: str | None = None,
        root_only: bool = False,
        since: datetime | None = None,
    ) -> SessionPeriodSummary:
        await self._authorize(workspace_id, owner_id)
        now = datetime.now(timezone.utc)
        since = as_utc(since) if since else None
        scope = {
            "board_id": board_id,
            "harness": harness,
            "root_only": root_only,
            "since": since,
        }
        live = self.repo.display_state_clause(
            ["active"],
            capture_switches(await self.repo.owner_installations(owner_id), now),
            now - IDLE_AFTER,
            now - ABANDONED_AFTER,
        )
        totals = await self.repo.period_totals(
            workspace_id,
            owner_id,
            live=live,
            spend_auth_kinds=SPEND_AUTH_KINDS,
            **scope,
        )
        spans = await self.repo.period_spans(workspace_id, owner_id, **scope)
        return SessionPeriodSummary(
            session_count=totals.session_count,
            live_count=totals.live_count,
            wall_duration_seconds=union_seconds(
                (max(as_utc(start), since) if since else start, end)
                for start, end in spans
            ),
            input_tokens=totals.input_tokens,
            output_tokens=totals.output_tokens,
            cache_read_tokens=totals.cache_read_tokens,
            cache_creation_tokens=totals.cache_creation_tokens,
            reasoning_tokens=totals.reasoning_tokens,
            cost_api_equivalent_usd=_money_total(totals.api_equivalent),
            cost_spend_usd=_money_total(totals.spend),
            cost_complete=not totals.unpriced_sessions,
        )

    # --- a companion device reading what it uploaded -------------------------

    async def _device_owned(
        self, installation: CompanionInstallation, session_id: uuid.UUID
    ) -> AgentSession:
        session = await self.repo.get_of_installation(
            installation.id, installation.owner_id, session_id
        )
        if session is None:
            raise ResourceNotFoundError("Session not found")
        return session

    async def list_device_sessions(
        self,
        installation: CompanionInstallation,
        *,
        status: str | None = None,
        cursor: str | None = None,
        limit: int = 50,
    ) -> AgentSessionPage:
        now = datetime.now(timezone.utc)
        rows = await self.repo.list_of_installation(
            installation.id,
            installation.owner_id,
            status=status,
            idle_before=now - IDLE_AFTER,
            abandoned_before=now - ABANDONED_AFTER,
            after=decode_cursor(cursor),
            limit=limit + 1,
        )
        page = rows[:limit]
        return AgentSessionPage(
            items=await self._reads(page, now, with_work=False),
            next_cursor=encode_cursor(page[-1].last_event_at, page[-1].id)
            if len(rows) > limit
            else None,
        )

    async def get_device_session(
        self, installation: CompanionInstallation, session_id: uuid.UUID
    ) -> AgentSessionRead:
        [read] = await self._reads(
            [await self._device_owned(installation, session_id)], with_work=False
        )
        return read

    async def device_session_usage(
        self, installation: CompanionInstallation, session_id: uuid.UUID
    ) -> SessionUsageList:
        await self._device_owned(installation, session_id)
        return await self._usage(session_id)

    async def get_session(self, workspace_id, owner_id, session_id) -> AgentSessionRead:
        [read] = await self._reads(
            [await self._owned(workspace_id, owner_id, session_id)]
        )
        return read

    async def list_children(
        self, workspace_id, owner_id, session_id
    ) -> AgentSessionList:
        await self._owned(workspace_id, owner_id, session_id)
        return AgentSessionList(
            items=await self._reads(
                await self.repo.owned_children(workspace_id, owner_id, session_id)
            )
        )

    async def delete_session(
        self, workspace_id: uuid.UUID, owner_id: uuid.UUID, session_id: uuid.UUID
    ) -> list[Invalidation]:
        """Delete a session's history up to now, leaving a tombstone that makes
        the owner's device drop anything it observed by then, retries and
        re-reads included. Later activity is a fresh session. Repeating is a
        no-op."""
        await self._authorize(workspace_id, owner_id)
        session = await self.repo.get_owned(workspace_id, owner_id, session_id)
        if session is None:
            if await self.repo.deleted_by_owner(owner_id, session_id):
                return []
            raise ResourceNotFoundError("Session not found")
        # Subagent threads are part of the same conversation: they go too. The
        # visited set and depth bound keep even a corrupt cycle finite.
        doomed = [session]
        seen = {session.id}
        frontier = [session.id]
        for _ in range(MAX_THREAD_DEPTH):
            if not frontier:
                break
            children = [
                child
                for child in await self.repo.owned_children_of(owner_id, frontier)
                if child.id not in seen
            ]
            seen.update(child.id for child in children)
            doomed.extend(children)
            frontier = [child.id for child in children]
        invalidations = [session_updated(item, "deleted") for item in doomed]
        deleted_at = datetime.now(timezone.utc)
        await self.repo.tombstone_and_delete(
            doomed,
            "owner",
            deleted_at,
            await history_cutoffs(self.repo, doomed, deleted_at),
            content_store().backend,
        )
        return invalidations

    async def list_events(
        self,
        workspace_id: uuid.UUID,
        owner_id: uuid.UUID,
        session_id: uuid.UUID,
        *,
        action: str | None = None,
        category: str | None = None,
        cursor: str | None = None,
        limit: int = 100,
    ) -> AgentSessionEventPage:
        session = await self._owned(workspace_id, owner_id, session_id)
        rows = await self.repo.list_events(
            session_id,
            action=action,
            category=category,
            after=decode_cursor(cursor),
            limit=limit + 1,
        )
        page = rows[:limit]
        levels = await self.repo.capture_content_levels(
            session.installation_id, {row.capture_id for row in page}
        )
        return AgentSessionEventPage(
            items=[event_read(row, levels.get(row.capture_id)) for row in page],
            next_cursor=encode_cursor(page[-1].occurred_at, page[-1].id)
            if len(rows) > limit
            else None,
        )

    async def usage_by_model(
        self, workspace_id, owner_id, session_id
    ) -> SessionUsageList:
        await self._owned(workspace_id, owner_id, session_id)
        return await self._usage(session_id)

    async def _usage(self, session_id: uuid.UUID) -> SessionUsageList:
        version = current_price_table().version
        groups = await self.usage.by_model(session_id, version)
        return SessionUsageList(
            items=[SessionModelUsage(**model_usage_fields(group)) for group in groups],
            price_table_version=version,
        )

    async def list_links(
        self, workspace_id, owner_id, session_id
    ) -> SessionWorkLinkList:
        await self._owned(workspace_id, owner_id, session_id)
        return SessionWorkLinkList(
            items=[
                SessionWorkLinkRead.model_validate(link)
                for link in await self.repo.visible_links(session_id, owner_id)
            ]
        )

    async def card_sessions(
        self,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID,
        card_id: uuid.UUID,
        owner_id: uuid.UUID,
        limit: int | None = None,
    ) -> LinkedSessionList:
        await self._authorize(workspace_id, owner_id)
        if not await self.repo.card_on_board(workspace_id, board_id, card_id):
            raise ResourceNotFoundError("Card not found", error_code="card_not_found")
        return await self._linked_sessions(owner_id, "card", card_id, limit)

    async def note_sessions(
        self,
        workspace_id: uuid.UUID,
        note_id: uuid.UUID,
        owner_id: uuid.UUID,
        limit: int | None = None,
    ) -> LinkedSessionList:
        await self._authorize(workspace_id, owner_id)
        if not await self.repo.note_in_workspace(workspace_id, note_id):
            raise ResourceNotFoundError("Note not found")
        return await self._linked_sessions(owner_id, "note", note_id, limit)

    async def _linked_sessions(
        self,
        owner_id: uuid.UUID,
        entity_type: str,
        entity_id: uuid.UUID,
        limit: int | None,
    ) -> LinkedSessionList:
        """The `limit` most recently active sessions, with the summary over
        every linked session."""
        sessions: dict[uuid.UUID, AgentSession] = {}
        relations: dict[uuid.UUID, set[str]] = {}
        seen: dict[uuid.UUID, tuple[datetime, datetime]] = {}
        exact: set[uuid.UUID] = set()
        for session, link in await self.repo.owned_sessions_linked_to(
            owner_id, entity_type, entity_id
        ):
            sessions.setdefault(session.id, session)
            relations.setdefault(session.id, set()).add(link.relation)
            if link.provenance == "exact":
                exact.add(session.id)
            first, last = seen.get(
                session.id, (as_utc(link.first_seen_at), as_utc(link.last_seen_at))
            )
            seen[session.id] = (
                min(first, as_utc(link.first_seen_at)),
                max(last, as_utc(link.last_seen_at)),
            )
        ordered = list(sessions.values())
        items = [
            LinkedSessionRead(
                session=read,
                relations=sorted(relations[read.id]),
                provenance="exact" if read.id in exact else "correlated",
                first_seen_at=seen[read.id][0],
                last_seen_at=seen[read.id][1],
            )
            for read in await self._reads(ordered[:limit])
        ]
        return LinkedSessionList(
            items=items, summary=linked_summary(ordered, seen.values())
        )
