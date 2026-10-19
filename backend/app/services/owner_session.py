# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Global owner discovery: metadata only, under current workspace membership."""

import base64
import hashlib
import json
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id, current_api_key_installation_id
from app.core.harness import harness_display_name
from app.core.time import as_utc
from app.exceptions import ForbiddenError, ValidationError
from app.repositories.agent_session import AgentSessionRepository, OwnerSessionMetadata
from app.schemas.owner_session import (
    OwnerSessionLinkPreview,
    OwnerSessionOverview,
    OwnerSessionPage,
    OwnerSessionRead,
)
from app.services.agent_session import (
    ABANDONED_AFTER,
    HEARTBEAT_STALE_AFTER,
    IDLE_AFTER,
    ended_reason,
    lifecycle_status,
    session_coverage,
)
from app.utils import utcnow

LONGEST_STATE_THRESHOLD = max(IDLE_AFTER, ABANDONED_AFTER, HEARTBEAT_STALE_AFTER)
EARLIEST_EVALUATION_CLOCK = (
    datetime.min.replace(tzinfo=timezone.utc) + LONGEST_STATE_THRESHOLD
)


def _utc_instant(value: str) -> datetime:
    # SQLite binds only wall-clock fields, so an offset must never reach SQL.
    return as_utc(datetime.fromisoformat(value)).astimezone(timezone.utc)


def _cursor_scope(owner_id: uuid.UUID, filters: dict) -> str:
    # Filters stay out of the token; even a shared cursor reveals no query text.
    raw = json.dumps([str(owner_id), filters], sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()


def _decode_cursor(
    cursor: str | None, scope: str
) -> tuple[datetime, tuple[datetime, uuid.UUID] | None]:
    if cursor is None:
        return as_utc(utcnow()), None
    try:
        if len(cursor) > 600:
            raise ValueError
        version, binding, evaluated_at, key, row_id = json.loads(
            base64.b64decode(
                cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True
            )
        )
        if (
            type(version) is not int
            or version != 1
            or binding != scope
            or not all(isinstance(value, str) for value in (evaluated_at, key, row_id))
        ):
            raise ValueError
        evaluated = _utc_instant(evaluated_at)
        # _page subtracts every capture-state threshold from this clock.
        if evaluated < EARLIEST_EVALUATION_CLOCK:
            raise ValueError
        return evaluated, (_utc_instant(key), uuid.UUID(row_id))
    except (ValueError, TypeError, OverflowError):
        raise ValidationError("Invalid cursor") from None


def _encode_cursor(scope: str, now: datetime, key: datetime, row_id: uuid.UUID) -> str:
    raw = json.dumps([1, scope, now.isoformat(), as_utc(key).isoformat(), str(row_id)])
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


class OwnerSessionService:
    def __init__(self, db: AsyncSession):
        self.repo = AgentSessionRepository(db)

    @staticmethod
    def _authorize() -> None:
        # Both credentials resolve to a human creator but must not inherit
        # that person's private capture discovery. Personal API keys retain access.
        if (
            current_agent_id.get() is not None
            or current_api_key_installation_id.get() is not None
        ):
            raise ForbiddenError("Agent credentials cannot read captured sessions")

    async def _page(self, owner_id, now, *, limit, after=None, **filters):
        return await self.repo.list_owner_metadata(
            owner_id,
            idle_before=now - IDLE_AFTER,
            abandoned_before=now - ABANDONED_AFTER,
            heartbeat_before=now - HEARTBEAT_STALE_AFTER,
            after=after,
            limit=limit,
            **filters,
        )

    async def _reads(
        self, owner_id: uuid.UUID, rows: list[OwnerSessionMetadata], now: datetime
    ) -> list[OwnerSessionRead]:
        session_ids = {row.session.id for row in rows}
        children = await self.repo.owner_child_counts(owner_id, session_ids)
        previews = await self.repo.owner_link_previews(owner_id, session_ids, 2)
        items = []
        for row in rows:
            session = row.session
            status = lifecycle_status(session, now)
            reason = ended_reason(session, status)
            count, links = previews.get(session.id, (0, []))
            items.append(
                OwnerSessionRead(
                    id=session.id,
                    workspace_id=session.workspace_id,
                    workspace_slug=row.workspace_slug,
                    workspace_name=row.workspace_name,
                    board_id=row.current_board_id,
                    board_name=row.board_name,
                    parent_session_id=session.parent_session_id,
                    harness=session.harness,
                    harness_display_name=harness_display_name(session.harness),
                    title=session.title,
                    repository=session.repository,
                    branch=session.branch,
                    status=status,
                    display_state=row.display_state,
                    started_at=session.started_at,
                    last_event_at=session.last_event_at,
                    ended_at=session.ended_at,
                    ended_reason=reason,
                    idle_since=session.last_event_at
                    if reason != "session_end_event"
                    and now - as_utc(session.last_event_at) > IDLE_AFTER
                    else None,
                    event_count=session.event_count,
                    activity_event_count=session.activity_event_count,
                    coverage=session_coverage(session, session.activity_event_count)
                    if session.activity_event_count is not None
                    else None,
                    capture_gaps=session.capture_gaps,
                    capture_levels=session.capture_levels or [],
                    child_count=children.get(session.id, 0),
                    link_count=count,
                    link_preview=[
                        OwnerSessionLinkPreview.model_validate(
                            link, from_attributes=True
                        )
                        for link in links
                    ],
                )
            )
        return items

    async def list_sessions(
        self,
        owner_id: uuid.UUID,
        *,
        workspace_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
        harness: str | None = None,
        status: str | None = None,
        states: list[str] | None = None,
        q: str | None = None,
        linked_only: bool = False,
        since: datetime | None = None,
        root_only: bool = True,
        sort: str = "recent",
        cursor: str | None = None,
        limit: int = 40,
    ) -> OwnerSessionPage:
        self._authorize()
        try:
            # Filter identity and SQL must agree on the instant, regardless of
            # timezone spelling; SQLite otherwise binds only wall-clock fields.
            since = as_utc(since).astimezone(timezone.utc) if since else None
        except (ValueError, OverflowError):
            raise ValidationError("Invalid since filter") from None
        filters = dict(
            workspace_id=workspace_id,
            board_id=board_id,
            harness=harness,
            status=status,
            states=sorted(set(states or [])),
            q=(q or "").strip() or None,
            linked_only=linked_only,
            since=since,
            root_only=root_only,
            sort=sort,
        )
        scope = _cursor_scope(owner_id, filters)
        now, after = _decode_cursor(cursor, scope)
        rows = await self._page(owner_id, now, limit=limit + 1, after=after, **filters)
        more = len(rows) > limit
        page = rows[:limit]
        return OwnerSessionPage(
            items=await self._reads(owner_id, page, now),
            next_cursor=_encode_cursor(
                scope, now, page[-1].sort_key, page[-1].session.id
            )
            if more
            else None,
        )

    async def overview(
        self, owner_id: uuid.UUID, *, active_limit: int = 6, recent_limit: int = 6
    ) -> OwnerSessionOverview:
        self._authorize()
        now = as_utc(utcnow())
        filters = dict(
            workspace_id=None,
            board_id=None,
            harness=None,
            status=None,
            q=None,
            linked_only=False,
            since=None,
            root_only=True,
            sort="recent",
        )
        active = await self._page(
            owner_id, now, states=["active"], limit=active_limit + 1, **filters
        )
        # Each statement gets its own READ COMMITTED snapshot, so a session can end
        # between them. Excluding every active row, lookahead included, keeps the
        # groups disjoint and recent_more about other sessions only.
        recent = await self._page(
            owner_id,
            now,
            states=["idle", "ended", "incomplete", "paused", "disconnected"],
            excluded_session_ids=[row.session.id for row in active],
            limit=recent_limit + 1,
            **filters,
        )
        active_page, recent_page = active[:active_limit], recent[:recent_limit]
        # Enrich both bounded groups together, never once per workspace or row.
        items = await self._reads(owner_id, active_page + recent_page, now)
        return OwnerSessionOverview(
            active=items[: len(active_page)],
            recent=items[len(active_page) :],
            active_more=len(active) > active_limit,
            recent_more=len(recent) > recent_limit,
            generated_at=now,
        )
