# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DependencyService — workspace-scoped, cycle-checked card dependency edits.

DEP-2 from spec note 233e4429 §Part A.

Public surface:
  - add(workspace_id, card_id, depends_on_card_id, actor_id) -> CardDependency
    Idempotent: returns existing row when the edge already exists.
    Rejects: self-deps, cycles, cross-workspace card refs, missing cards.
  - remove(workspace_id, card_id, depends_on_card_id) -> bool
    Idempotent: deleting a missing edge is a no-op success.
  - list_for_card(workspace_id, card_id) -> CardDependenciesView
    Bidirectional view (depends_on + blocks).
  - bulk_set(workspace_id, card_id, depends_on_card_ids, actor_id) -> view
    Atomic replace. Rejects whole set on any cycle.

Cycle detection uses a recursive CTE walking forward from
`depends_on_card_id`. If the walk visits `card_id`, the new edge would
close a cycle. SQLite ≥3.8.3 (aiosqlite default) supports the syntax,
matching Postgres prod behavior.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Iterable

from sqlalchemy import literal, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.kanban.card import Card, CardDependency
from app.repositories.kanban.dependencies import (
    DependencyEdge,
    DependencyRepository,
)
from app.services.activity import ActivityService
from app.services.kanban.completion_dependencies import CompletionDependencyService
from app.services.kanban.freeze_guard import assert_board_not_frozen
from app.services.scheduling.assignment_service import _truncate_title


@dataclass
class CardDependenciesView:
    depends_on: list[DependencyEdge] = field(default_factory=list)
    blocks: list[DependencyEdge] = field(default_factory=list)

    @property
    def ready(self):
        return all(edge.satisfied for edge in self.depends_on)


def _dependency_summary(verb: str, title: str) -> str:
    """Activity.summary is String(500) and so is Card.title: bound the title so
    a max-length prerequisite cannot overflow the column on Postgres."""
    return f"{verb} dependency on card '{_truncate_title(title)}'"


class DependencyService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = DependencyRepository(db)

    async def add(
        self,
        *,
        workspace_id: uuid.UUID,
        card_id: uuid.UUID,
        depends_on_card_id: uuid.UUID,
        actor_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
    ) -> CardDependency:
        await self._assert_card_scope(workspace_id, card_id, board_id, lock=True)
        if card_id == depends_on_card_id:
            raise ValidationError(
                "A card cannot depend on itself",
                error_code="validation_error",
            )

        for ref in (card_id, depends_on_card_id):
            if not await self.repo.card_in_workspace(ref, workspace_id):
                raise ResourceNotFoundError("Card not found")

        # A cross-board edge gates on the primary card's board only.
        await assert_board_not_frozen(
            self.db, await self._board_id_for_card(card_id)
        )

        existing = await self.repo.get(card_id, depends_on_card_id)
        if existing is not None:
            await self._attach_satisfied([existing], workspace_id)
            return existing

        if await self._would_cycle(card_id, depends_on_card_id):
            raise ValidationError(
                f"Adding {card_id} -> {depends_on_card_id} would create a cycle",
                error_code="cycle_detected",
            )

        try:
            dep = await self.repo.create(
                card_id=card_id,
                depends_on_card_id=depends_on_card_id,
                created_by=actor_id,
            )
        except IntegrityError:
            # Concurrent insert lost the race. Re-fetch and return.
            await self.db.rollback()
            existing = await self.repo.get(card_id, depends_on_card_id)
            if existing is None:
                raise
            return existing

        depends_on_title = await self._title_for_card(depends_on_card_id)
        await self._record_activity(
            workspace_id=workspace_id,
            actor_id=actor_id,
            card_id=card_id,
            action=ActivityAction.dependency_added,
            summary=_dependency_summary("added", depends_on_title),
            message_key="activity.card.dependency_added",
            message_params={
                "depends_on_card_id": str(depends_on_card_id),
                "depends_on_title": depends_on_title,
            },
            changes={"depends_on_card_id": str(depends_on_card_id)},
        )
        await self._attach_satisfied([dep], workspace_id)
        return dep

    async def remove(
        self,
        *,
        workspace_id: uuid.UUID,
        card_id: uuid.UUID,
        depends_on_card_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
        board_id: uuid.UUID | None = None,
    ) -> bool:
        await self._assert_card_scope(workspace_id, card_id, board_id, lock=True)
        for ref in (card_id, depends_on_card_id):
            if not await self.repo.card_in_workspace(ref, workspace_id):
                raise ResourceNotFoundError("Card not found")
        await assert_board_not_frozen(
            self.db, await self._board_id_for_card(card_id)
        )
        deleted = await self.repo.delete_one(card_id, depends_on_card_id)
        if deleted and actor_id is not None:
            depends_on_title = await self._title_for_card(depends_on_card_id)
            await self._record_activity(
                workspace_id=workspace_id,
                actor_id=actor_id,
                card_id=card_id,
                action=ActivityAction.dependency_removed,
                summary=_dependency_summary("removed", depends_on_title),
                message_key="activity.card.dependency_removed",
                message_params={
                    "depends_on_card_id": str(depends_on_card_id),
                    "depends_on_title": depends_on_title,
                },
                changes={"depends_on_card_id": str(depends_on_card_id)},
            )
        return deleted

    async def list_for_card(
        self, *, workspace_id: uuid.UUID, card_id: uuid.UUID, board_id: uuid.UUID | None = None
    ) -> CardDependenciesView:
        await self._assert_card_scope(workspace_id, card_id, board_id)
        view = CardDependenciesView(
            depends_on=await self.repo.list_depends_on(card_id),
            blocks=await self.repo.list_blocks(card_id),
        )
        await self._attach_satisfied(view.depends_on + view.blocks, workspace_id)
        return view

    async def _attach_satisfied(self, edges, workspace_id):
        satisfied = await CompletionDependencyService(self.db).satisfied_ids(
            {edge.depends_on_card_id for edge in edges}, workspace_id=workspace_id,
        )
        for edge in edges:
            edge.satisfied = edge.depends_on_card_id in satisfied

    async def _assert_card_scope(self, workspace_id, card_id, board_id=None, *, lock=False):
        if lock:
            await CompletionDependencyService(self.db).repo.lock_workspace(workspace_id)
        if not await self.repo.card_in_workspace(card_id, workspace_id, board_id):
            raise ResourceNotFoundError("Card not found")

    async def list_for_board(
        self, *, board_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, uuid.UUID]]:
        # Board identity + workspace membership are enforced by the router's
        # resolve_board_id + get_workspace dependencies before we get here.
        return await self.repo.list_for_board(board_id)

    async def bulk_set(
        self,
        *,
        workspace_id: uuid.UUID,
        card_id: uuid.UUID,
        depends_on_card_ids: Iterable[uuid.UUID],
        actor_id: uuid.UUID,
        board_id: uuid.UUID | None = None,
    ) -> CardDependenciesView:
        await self._assert_card_scope(workspace_id, card_id, board_id, lock=True)
        target_ids = list(dict.fromkeys(depends_on_card_ids))  # dedupe, preserve order
        if not await self.repo.card_in_workspace(card_id, workspace_id):
            raise ResourceNotFoundError("Card not found")
        await assert_board_not_frozen(
            self.db, await self._board_id_for_card(card_id)
        )
        for ref in target_ids:
            if ref == card_id:
                raise ValidationError(
                    "A card cannot depend on itself",
                    error_code="validation_error",
                )
            if not await self.repo.card_in_workspace(ref, workspace_id):
                raise ResourceNotFoundError("Card not found")
            if await self._would_cycle(card_id, ref):
                raise ValidationError(
                    f"Adding {card_id} -> {ref} would create a cycle",
                    error_code="cycle_detected",
                )

        await self.repo.delete_all_for_card(card_id)
        for ref in target_ids:
            await self.repo.create(
                card_id=card_id,
                depends_on_card_id=ref,
                created_by=actor_id,
            )
        await self._record_activity(
            workspace_id=workspace_id,
            actor_id=actor_id,
            card_id=card_id,
            action=ActivityAction.dependencies_replaced,
            summary=f"set {len(target_ids)} dependencies",
            message_key="activity.card.dependencies_replaced",
            message_params={"dependency_count": len(target_ids)},
            changes={"depends_on_card_ids": [str(x) for x in target_ids]},
        )
        return await self.list_for_card(
            workspace_id=workspace_id, card_id=card_id
        )

    async def _record_activity(
        self,
        *,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID,
        card_id: uuid.UUID,
        action: ActivityAction,
        summary: str,
        message_key: str,
        message_params: dict,
        changes: dict,
    ) -> None:
        board_id = await self._board_id_for_card(card_id)
        await ActivityService(self.db).record(
            workspace_id=workspace_id,
            actor_id=actor_id,
            entity_type=ActivityEntityType.card,
            entity_id=card_id,
            action=action,
            board_id=board_id,
            summary=summary,
            message_key=message_key,
            message_params=message_params,
            changes=changes,
        )

    async def _board_id_for_card(self, card_id: uuid.UUID) -> uuid.UUID | None:
        result = await self.db.execute(
            select(Card.board_id).where(Card.id == card_id)
        )
        return result.scalar_one_or_none()

    async def _title_for_card(self, card_id: uuid.UUID) -> str:
        # Callers validate the card exists (card_in_workspace) before recording.
        result = await self.db.execute(
            select(Card.title).where(Card.id == card_id)
        )
        return result.scalar_one()

    async def _would_cycle(
        self, card_id: uuid.UUID, depends_on_card_id: uuid.UUID
    ) -> bool:
        """Return True iff `depends_on_card_id` already (transitively)
        depends on `card_id` — making the new edge a back-edge that
        closes a cycle.

        Walks forward from `depends_on_card_id` via recursive CTE, looking
        for `card_id` in the reachable set.
        """
        # Recursive CTE: seed = depends_on_card_id; step = follow card_id ->
        # depends_on_card_id edges, collecting reachable node ids.
        base = select(literal(depends_on_card_id).label("node_id")).cte(
            "reachable", recursive=True
        )
        step = (
            select(CardDependency.depends_on_card_id.label("node_id"))
            .join(base, CardDependency.card_id == base.c.node_id)
        )
        reachable = base.union_all(step)
        result = await self.db.execute(
            select(reachable.c.node_id).where(reachable.c.node_id == card_id)
        )
        return result.scalar_one_or_none() is not None
