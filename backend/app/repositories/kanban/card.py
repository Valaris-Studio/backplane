# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime

from sqlalchemy import String, cast, exists, func, or_, select
from sqlalchemy.orm import selectinload

from app.models.agents.execution import AgentExecution
from app.models.approvals.approval import ApprovalRequest, ApprovalStatus
from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.repositories.base import BaseRepository


class CardRepository(BaseRepository[Card]):
    model = Card

    async def get_by_id(self, id: uuid.UUID) -> Card | None:
        result = await self.db.execute(
            select(Card)
            .where(Card.id == id)
            .options(selectinload(Card.participants).selectinload(CardParticipant.user), selectinload(Card.participants).selectinload(CardParticipant.agent))
        )
        return result.scalar_one_or_none()

    async def create(self, **kwargs) -> Card:
        card = Card(**kwargs)
        self.db.add(card)
        await self.db.flush()
        return await self.get_by_id(card.id)

    async def update(self, instance: Card, **kwargs) -> Card:
        for key, value in kwargs.items():
            setattr(instance, key, value)
        await self.db.flush()
        return await self.get_by_id(instance.id)

    async def list_by_board(self, board_id: uuid.UUID) -> list[Card]:
        result = await self.db.execute(
            select(Card).where(Card.board_id == board_id).order_by(Card.position)
        )
        return list(result.scalars().all())

    async def find_by_id_prefix(
        self, board_id: uuid.UUID, prefix: str, *, limit: int = 10
    ) -> list[Card]:
        """Cards on `board_id` whose UUID starts with `prefix`.

        UUIDs render lowercase, so we lowercase the needle and cast the id to
        text for a `LIKE 'prefix%'`. Scoped to the denormalized `board_id`;
        capped at `limit` so an over-broad prefix can't scan the whole board.
        Participants are eager-loaded to match get_by_id — the service returns a
        full CardRead on a unique match without a lazy load.

        Hyphens are stripped from BOTH the needle and the cast id before
        comparison: Postgres's `uuid::text` renders the canonical hyphenated
        form while SQLite stores a hyphen-less 32-hex string, and callers may
        pass a fragment with or without hyphens. Normalizing both sides makes
        the match dialect- and format-neutral.
        """
        needle = prefix.lower().replace("-", "")
        id_text = func.replace(cast(Card.id, String), "-", "")
        result = await self.db.execute(
            select(Card)
            .where(
                Card.board_id == board_id,
                id_text.like(f"{needle}%"),
            )
            .options(
                selectinload(Card.participants).selectinload(CardParticipant.user),
                selectinload(Card.participants).selectinload(CardParticipant.agent),
            )
            .order_by(Card.position)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_max_position(self, column_id: uuid.UUID) -> float:
        result = await self.db.execute(
            select(func.coalesce(func.max(Card.position), 0.0)).where(
                Card.column_id == column_id
            )
        )
        return result.scalar_one()

    async def get_max_positions(self, column_ids: set[uuid.UUID]) -> dict[uuid.UUID, float]:
        result = await self.db.execute(
            select(Card.column_id, func.coalesce(func.max(Card.position), 0.0))
            .where(Card.column_id.in_(column_ids))
            .group_by(Card.column_id)
        )
        positions = {row[0]: row[1] for row in result.all()}
        for col_id in column_ids:
            positions.setdefault(col_id, 0.0)
        return positions

    async def get_refs_by_ids(
        self, card_ids: set[uuid.UUID]
    ) -> dict[uuid.UUID, tuple[str, uuid.UUID]]:
        """Batch-resolve {card_id: (title, board_id)} for enrichment.

        A scalar tuple-select (title + board_id) — NOT a full ORM load — so the
        service can turn cards_affected / entity_id references into linkable
        titles in ONE query per request. Missing ids are omitted; callers treat
        an absent id as a deleted card.
        """
        if not card_ids:
            return {}
        result = await self.db.execute(
            select(Card.id, Card.title, Card.board_id).where(Card.id.in_(card_ids))
        )
        return {row[0]: (row[1], row[2]) for row in result.all()}

    async def move_card(
        self, card: Card, column_id: uuid.UUID, board_id: uuid.UUID, position: float
    ) -> Card:
        card.column_id = column_id
        card.board_id = board_id
        card.position = position
        await self.db.flush()
        return await self.get_by_id(card.id)

    async def add_participant(
        self, card_id: uuid.UUID, user_id: uuid.UUID, role: str,
        agent_id: uuid.UUID | None = None,
        pipeline_role: str | None = None,
    ) -> CardParticipant:
        participant = CardParticipant(
            card_id=card_id, user_id=user_id, role=role,
            agent_id=agent_id, pipeline_role=pipeline_role,
        )
        self.db.add(participant)
        await self.db.flush()
        await self.db.refresh(participant, attribute_names=["user"])
        return participant

    async def backfill_pipeline_role(
        self, participant: CardParticipant, pipeline_role: str
    ) -> CardParticipant:
        """Fill a NULL `pipeline_role` on an existing row.

        Caller is responsible for the NULL precondition — this method just
        sets the column and flushes. Used by the idempotent add_participant
        path to migrate legacy rows on-the-fly when a runner re-claims.
        """
        participant.pipeline_role = pipeline_role
        await self.db.flush()
        return participant

    async def remove_participant(self, card_id: uuid.UUID, user_id: uuid.UUID) -> bool:
        result = await self.db.execute(
            select(CardParticipant).where(
                CardParticipant.card_id == card_id,
                CardParticipant.user_id == user_id,
            )
        )
        participant = result.scalar_one_or_none()
        if not participant:
            return False
        await self.db.delete(participant)
        await self.db.flush()
        return True

    async def remove_participants_by_pipeline_role(
        self, card_id: uuid.UUID, pipeline_role: str
    ) -> int:
        result = await self.db.execute(
            select(CardParticipant).where(
                CardParticipant.card_id == card_id,
                CardParticipant.pipeline_role == pipeline_role,
            )
        )
        participants = list(result.scalars().all())
        for participant in participants:
            await self.db.delete(participant)
        await self.db.flush()
        return len(participants)

    async def get_participant(self, card_id: uuid.UUID, user_id: uuid.UUID) -> CardParticipant | None:
        result = await self.db.execute(
            select(CardParticipant).where(
                CardParticipant.card_id == card_id,
                CardParticipant.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_hero(self, card_id: uuid.UUID) -> CardParticipant | None:
        result = await self.db.execute(
            select(CardParticipant).where(
                CardParticipant.card_id == card_id,
                CardParticipant.role == "hero",
            )
        )
        return result.scalar_one_or_none()

    async def get_for_update(self, card_id: uuid.UUID) -> Card | None:
        """Fetch a card with a row-level lock for atomic operations."""
        result = await self.db.execute(
            select(Card)
            .where(Card.id == card_id)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def pending_approvals_by_card(
        self,
        card_ids: set[uuid.UUID],
        *,
        workspace_id: uuid.UUID | None = None,
    ) -> dict[uuid.UUID, uuid.UUID]:
        """Map card_id -> pending approval_id for the given cards.

        One SELECT joins approvals to their executions (LEFT JOIN — execution
        may be null). We then resolve card-linkage in Python across the two
        JSON surfaces (`action_payload.card_id` primary, `cards_affected`
        fallback) because the two columns are plain JSON (not JSONB) and
        cross-dialect JSON operators are painful. The working set is bounded
        by the small count of *pending* approvals on the workspace.

        Stale `pending` rows whose `expires_at` has passed are excluded —
        approval expiry is normally swept by a background job, but card
        50016881 reproduced cards stuck "Awaiting approval" because the
        sweep had not yet run after a runner crash. Reading the timestamp
        here makes the operator-facing flag self-correcting.
        """
        if not card_ids:
            return {}

        query = (
            select(ApprovalRequest.id, ApprovalRequest.action_payload, AgentExecution.cards_affected)
            .join(
                AgentExecution,
                AgentExecution.id == ApprovalRequest.execution_id,
                isouter=True,
            )
            .where(
                ApprovalRequest.status == ApprovalStatus.pending,
                ApprovalRequest.expires_at > datetime.utcnow(),
            )
            .order_by(ApprovalRequest.created_at.desc())
        )
        if workspace_id is not None:
            query = query.where(ApprovalRequest.workspace_id == workspace_id)

        result = await self.db.execute(query)

        target_ids = {str(cid) for cid in card_ids}
        mapping: dict[uuid.UUID, uuid.UUID] = {}

        for approval_id, action_payload, cards_affected in result.all():
            payload_card_id = (action_payload or {}).get("card_id")
            candidates: set[str] = set()
            if isinstance(payload_card_id, str):
                candidates.add(payload_card_id)
            if isinstance(cards_affected, list):
                candidates.update(str(c) for c in cards_affected if c)

            for raw in candidates & target_ids:
                card_uuid = uuid.UUID(raw)
                # `order_by desc()` above means the first pending approval we
                # see for a card is the most recent; skip if already set.
                mapping.setdefault(card_uuid, approval_id)

        return mapping

    async def search(
        self,
        board_id: uuid.UUID,
        *,
        q: str | None = None,
        priority: str | None = None,
        card_type: str | None = None,
        status: str | None = None,
        label: str | None = None,
        has_assignee: bool | None = None,
        assignee_id: uuid.UUID | None = None,
        column_id: uuid.UUID | None = None,
        column_type: str | None = None,
        exclude_column_type: str | None = None,
        include_untyped: bool = True,
        overdue: bool | None = None,
        ineligible_ids: set[uuid.UUID] | None = None,
        limit: int = 50,
    ) -> list[Card]:
        query = select(Card).where(Card.board_id == board_id)

        if q:
            pattern = f"%{q}%"
            query = query.where(
                or_(Card.title.ilike(pattern), Card.description.ilike(pattern))
            )

        if priority:
            query = query.where(Card.priority == priority)

        if card_type:
            query = query.where(Card.card_type == card_type)

        if status:
            query = query.where(Card.status == status)

        if label:
            # Exact array-membership match on the JSON `labels` column.
            # `Card.labels` is stored as JSON (text on SQLite, JSON on Postgres),
            # so we can't use JSONB containment. Instead we rely on the fact that
            # JSON arrays serialize each string element with surrounding double
            # quotes: `["role:implementer"]` -> `["role:implementer"]`. Wrapping
            # the needle in quotes bounds the LIKE and prevents
            # `role:implementer-skip` from matching `role:implementer`.
            # Assumes labels do not contain a literal `"` — true in practice.
            query = query.where(Card.labels.cast(String).like(f'%"{label}"%'))

        if has_assignee is True:
            hero_exists = exists().where(
                CardParticipant.card_id == Card.id,
                CardParticipant.role == "hero",
            )
            query = query.where(hero_exists)
        elif has_assignee is False:
            hero_exists = exists().where(
                CardParticipant.card_id == Card.id,
                CardParticipant.role == "hero",
            )
            query = query.where(~hero_exists)

        if assignee_id:
            # Match on user_id OR agent_id so both human and agent lookups work.
            participant_exists = exists().where(
                CardParticipant.card_id == Card.id,
                or_(
                    CardParticipant.user_id == assignee_id,
                    CardParticipant.agent_id == assignee_id,
                ),
            )
            query = query.where(participant_exists)

        if column_id:
            query = query.where(Card.column_id == column_id)

        if column_type:
            query = query.join(Column, Card.column_id == Column.id).where(
                Column.column_type == column_type
            )

        if exclude_column_type:
            # Exclude cards in columns of this type (cards in untyped columns are kept)
            excluded_col_ids = select(Column.id).where(
                Column.board_id == board_id,
                Column.column_type == exclude_column_type,
            )
            query = query.where(Card.column_id.notin_(excluded_col_ids))

        if not include_untyped:
            typed_col_ids = select(Column.id).where(
                Column.board_id == board_id,
                Column.column_type.isnot(None),
            )
            query = query.where(Card.column_id.in_(typed_col_ids))

        if overdue is True:
            query = query.where(Card.due_date < date.today(), Card.due_date.isnot(None))

        if ineligible_ids:
            query = query.where(Card.id.notin_(ineligible_ids))

        query = query.options(
            selectinload(Card.participants).selectinload(CardParticipant.user),
            selectinload(Card.participants).selectinload(CardParticipant.agent),
        )
        query = query.order_by(Card.position).limit(limit)

        result = await self.db.execute(query)
        return list(result.scalars().all())
