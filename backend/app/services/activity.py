# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.activity import ActivityAction, ActivityEntityType
from app.repositories.activity import ActivityRepository

logger = logging.getLogger(__name__)

# Bridge events: the five original namespaced events that predate the
# activity.{entity}.{action} fan-out. They continue to fire alongside their
# activity.* twin so existing webhook subscribers and frontend hooks keep
# working. DEPRECATED — sunset planned once consumers migrate to activity.*.
# Do NOT extend this map. New entity/action pairs should rely solely on the
# activity.* namespace.
_BRIDGE_EVENTS: dict[tuple[ActivityEntityType, ActivityAction], str] = {
    (ActivityEntityType.card, ActivityAction.created): "card.created",
    (ActivityEntityType.card, ActivityAction.updated): "card.updated",
    (ActivityEntityType.card, ActivityAction.moved): "card.moved",
    (ActivityEntityType.card, ActivityAction.deleted): "card.deleted",
    (ActivityEntityType.column, ActivityAction.created): "column.created",
    (ActivityEntityType.column, ActivityAction.updated): "column.updated",
    (ActivityEntityType.column, ActivityAction.deleted): "column.deleted",
}


def _activity_event_type(
    entity_type: ActivityEntityType, action: ActivityAction
) -> str:
    return f"activity.{entity_type.value}.{action.value}"


class ActivityService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ActivityRepository(db)
        from app.repositories.kanban.card import CardRepository
        from app.repositories.notes.note import NoteRepository

        self.card_repo = CardRepository(db)
        self.note_repo = NoteRepository(db)

    async def record(
        self,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        entity_type: ActivityEntityType,
        entity_id: uuid.UUID,
        action: ActivityAction,
        board_id: uuid.UUID | None = None,
        summary: str = "",
        message_key: str | None = None,
        message_params: dict | None = None,
        changes: dict | None = None,
        before_state: dict | None = None,
        after_state: dict | None = None,
    ) -> None:
        from app.core.auth import current_agent_id, current_api_key_name

        activity = await self.repo.record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            board_id=board_id,
            summary=summary,
            message_key=message_key,
            message_params=message_params,
            changes=changes,
            before_state=before_state,
            after_state=after_state,
            via_api_key=current_api_key_name.get(),
            agent_id=current_agent_id.get(),
        )

        await self._generate_notifications(activity, params=changes)

        payload = {
            "entity_type": entity_type.value,
            "entity_id": str(entity_id),
            "action": action.value,
            "actor_id": str(actor_id),
            "board_id": str(board_id) if board_id else None,
            "summary": summary,
            "message_key": message_key,
            "message_params": message_params,
            "changes": changes,
        }

        # Primary fan-out: always publish the generic activity.{entity}.{action}
        # event. Subscribers use fnmatch patterns (e.g. "activity.note.*",
        # "activity.*.deleted", "activity.*") to filter.
        activity_event = _activity_event_type(entity_type, action)
        await self._publish(activity_event, payload, workspace_id)

        # Bridge fan-out: deprecated legacy events emitted in parallel.
        bridge_event = _BRIDGE_EVENTS.get((entity_type, action))
        if bridge_event:
            await self._publish(bridge_event, payload, workspace_id)

    async def _generate_notifications(self, activity, params: dict | None) -> None:
        """Fan the freshly-written activity into durable notifications (INV-2
        source path). Runs IN the triggering txn, so a failure here would roll
        the mutation back — caught and logged so the activity stays durable and
        generation degrades to a no-op (Group G sentinel). is_agent_actor reads
        the row's agent_id (set from current_agent_id at record time) — no
        contextvar access needed (contract §"is_agent_actor source CONFIRMED")."""
        from app.services.notifications.generation import (
            NotificationService,
            category_for_activity,
        )

        category = category_for_activity(activity.entity_type, activity.action)
        if category is None:
            return

        changes = params or {}
        # card_comment is a note event but its recipients are the COMMENTED
        # card's participants — route entity_id to the card_id the note service
        # enriched into changes; a note with no card_id has no card_comment.
        if category == "card_comment":
            card_id = changes.get("card_id")
            if card_id is None:
                return
            entity_type = "card"
            entity_id = uuid.UUID(str(card_id))
            link = {"kind": "card", "card_id": str(entity_id)}
        else:
            entity_type = activity.entity_type.value
            entity_id = activity.entity_id
            link = (
                {"kind": entity_type, "card_id": str(entity_id)}
                if entity_type == "card"
                else None
            )

        # INV-5: params carry only STRUCTURED data (column names, ids, actor) —
        # never the human-readable `summary` sentence (the FE composes copy from
        # category + params via i18n). `changes` is already structured.
        notif_params = dict(changes)
        # begin_nested() issues a SAVEPOINT around generation. On asyncpg a SQL
        # error inside a plain try/except aborts the WHOLE transaction, so the
        # outer get_db commit would raise InFailedSQLTransaction and roll the
        # triggering activity back. The savepoint scopes a failure to the nested
        # block: __aexit__ rolls the savepoint back, then the broad except
        # swallows — leaving the outer txn committable so the activity stays
        # durable (Group G: generation degrades to a no-op, never a regression).
        try:
            async with self.db.begin_nested():
                await NotificationService(self.db).generate_for_event(
                    self.db,
                    workspace_id=activity.workspace_id,
                    board_id=activity.board_id,
                    category=category,
                    actor_id=activity.actor_id,
                    is_agent_actor=activity.agent_id is not None,
                    entity_type=entity_type,
                    entity_id=entity_id,
                    # Seed off activity.id, NOT activity.seq: seq is a PG IDENTITY
                    # (non-PK) that the INSERT omits, so it is None on the instance
                    # after flush on Postgres (SQLite fills it via before_insert, so
                    # the all-SQLite suite never saw "None"). activity.id is the PK,
                    # always populated post-flush via RETURNING on both dialects —
                    # equally deterministic + unique per event for the dedupe_key.
                    dedupe_seed=str(activity.id),
                    params=notif_params,
                    link=link,
                )
        except Exception:
            logger.exception(
                "notification generation failed for activity %s", activity.id
            )

    async def _publish(
        self, event_type: str, payload: dict, workspace_id: uuid.UUID
    ) -> None:
        try:
            await event_bus.publish(
                event_type=event_type,
                payload=payload,
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish event %s", event_type)

    async def list_workspace_activity(
        self,
        workspace_id: uuid.UUID,
        limit: int = 50,
        before: datetime | None = None,
        entity_type: ActivityEntityType | None = None,
        action: ActivityAction | None = None,
        actor_id: uuid.UUID | None = None,
        search: str | None = None,
        agent_id: uuid.UUID | None = None,
    ):
        rows = await self.repo.list_by_workspace(
            workspace_id,
            limit,
            before,
            entity_type=entity_type,
            action=action,
            actor_id=actor_id,
            search=search,
            agent_id=agent_id,
        )
        return await self._attach_entity_titles(rows)

    async def _attach_entity_titles(self, rows: list) -> list:
        """Set the transient `entity_title` on each row for entity types that
        have both a title AND a route (card, note). Batched: one card query +
        one note query per call over the DISTINCT ids, regardless of row count.
        Title-less types (board/column/workspace/...) and deleted entities keep
        entity_title None. ActivityRead.from_attributes reads the attribute."""
        card_ids: set[uuid.UUID] = set()
        note_ids: set[uuid.UUID] = set()
        for row in rows:
            if row.entity_type == ActivityEntityType.card:
                card_ids.add(row.entity_id)
            elif row.entity_type == ActivityEntityType.note:
                note_ids.add(row.entity_id)

        card_refs = await self.card_repo.get_refs_by_ids(card_ids)
        note_titles = await self.note_repo.get_titles_by_ids(note_ids)

        for row in rows:
            if row.entity_type == ActivityEntityType.card:
                ref = card_refs.get(row.entity_id)
                row.entity_title = ref[0] if ref else None
            elif row.entity_type == ActivityEntityType.note:
                row.entity_title = note_titles.get(row.entity_id)
            else:
                row.entity_title = None
        return rows

    async def build_board_baseline(self, board_id: uuid.UUID):
        """Build the current-state baseline (contract v1.1) the timeline engine
        seeds from before folding events. Reuses the SAME eager-loaded board
        detail the board endpoint uses (columns ordered by position, each card
        with participants→user/agent loaded) so snapshot_* never lazy-loads
        (MissingGreenlet). Returns None only when the board has no detail."""
        from app.repositories.kanban.board import BoardRepository
        from app.schemas.activity import BoardBaseline
        from app.services.kanban.snapshots import snapshot_card, snapshot_column

        board = await BoardRepository(self.db).get_full_board(board_id)
        if board is None:
            return None
        columns = [snapshot_column(c) for c in board.columns]
        cards = [
            snapshot_card(card) for column in board.columns for card in column.cards
        ]
        return BoardBaseline(columns=columns, cards=cards)

    async def list_board_timeline(
        self, board_id: uuid.UUID, limit: int = 5000
    ) -> tuple[list, bool]:
        """Return (events ASC, truncated). Over-limit returns the OLDEST `limit`
        events and flags truncation — never silently dropping."""
        rows = await self.repo.list_board_timeline(board_id, limit)
        truncated = len(rows) > limit
        if truncated:
            rows = rows[:limit]
            logger.warning(
                "board timeline truncated at %d events (board=%s)", limit, board_id
            )
        rows = await self._attach_entity_titles(rows)
        return rows, truncated

    async def list_board_activity(
        self,
        board_id: uuid.UUID,
        limit: int = 50,
        before: datetime | None = None,
        entity_type: ActivityEntityType | None = None,
        action: ActivityAction | None = None,
        actor_id: uuid.UUID | None = None,
        search: str | None = None,
        agent_id: uuid.UUID | None = None,
    ):
        rows = await self.repo.list_by_board(
            board_id,
            limit,
            before,
            entity_type=entity_type,
            action=action,
            actor_id=actor_id,
            search=search,
            agent_id=agent_id,
        )
        return await self._attach_entity_titles(rows)
