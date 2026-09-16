# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Pure data access for card_dependencies (DEP-2).

Workspace-scoping + cycle detection live in DependencyService — this
repository is the minimal SQL surface.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column


@dataclass
class DependencyEdge:
    """A dependency edge with the *displayed* card's projection attached.

    The `depends_on_*` fields describe whichever card the detail view
    renders for this edge: the prerequisite (`depends_on_card_id`) in the
    forward/`depends_on` direction, and the dependent (`card_id`) in the
    reverse/`blocks` direction. CardDependencyRead reads these by attribute.
    """

    card_id: uuid.UUID
    depends_on_card_id: uuid.UUID
    created_at: datetime
    created_by: uuid.UUID
    depends_on_title: str | None
    depends_on_status: str | None
    depends_on_column_type: str | None
    satisfied: bool = False


class DependencyRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get(
        self, card_id: uuid.UUID, depends_on_card_id: uuid.UUID
    ) -> CardDependency | None:
        result = await self.db.execute(
            select(CardDependency).where(
                CardDependency.card_id == card_id,
                CardDependency.depends_on_card_id == depends_on_card_id,
            )
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        *,
        card_id: uuid.UUID,
        depends_on_card_id: uuid.UUID,
        created_by: uuid.UUID,
    ) -> CardDependency:
        dep = CardDependency(
            card_id=card_id,
            depends_on_card_id=depends_on_card_id,
            created_by=created_by,
        )
        self.db.add(dep)
        await self.db.flush()
        return dep

    async def delete_one(
        self, card_id: uuid.UUID, depends_on_card_id: uuid.UUID
    ) -> bool:
        result = await self.db.execute(
            delete(CardDependency).where(
                CardDependency.card_id == card_id,
                CardDependency.depends_on_card_id == depends_on_card_id,
            )
        )
        await self.db.flush()
        return (result.rowcount or 0) > 0

    async def delete_all_for_card(self, card_id: uuid.UUID) -> None:
        await self.db.execute(
            delete(CardDependency).where(CardDependency.card_id == card_id)
        )
        await self.db.flush()

    async def list_depends_on(self, card_id: uuid.UUID) -> list[DependencyEdge]:
        # Forward edges: project the prerequisite (`depends_on_card_id`).
        result = await self.db.execute(
            select(
                CardDependency.card_id,
                CardDependency.depends_on_card_id,
                CardDependency.created_at,
                CardDependency.created_by,
                Card.title,
                Card.status,
                Column.column_type,
            )
            .join(Card, Card.id == CardDependency.depends_on_card_id)
            .join(Column, Column.id == Card.column_id)
            .where(CardDependency.card_id == card_id)
        )
        return [self._to_edge(row) for row in result.all()]

    async def list_blocks(self, card_id: uuid.UUID) -> list[DependencyEdge]:
        # Reverse edges: the detail view renders the dependent (`card_id`),
        # so project that card rather than the prerequisite.
        result = await self.db.execute(
            select(
                CardDependency.card_id,
                CardDependency.depends_on_card_id,
                CardDependency.created_at,
                CardDependency.created_by,
                Card.title,
                Card.status,
                Column.column_type,
            )
            .join(Card, Card.id == CardDependency.card_id)
            .join(Column, Column.id == Card.column_id)
            .where(CardDependency.depends_on_card_id == card_id)
        )
        return [self._to_edge(row) for row in result.all()]

    async def list_for_board(
        self, board_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, uuid.UUID]]:
        """All (card_id, depends_on_card_id) edges whose *dependent* card lives
        on this board. Powers the board-level tree view in one query."""
        result = await self.db.execute(
            select(
                CardDependency.card_id,
                CardDependency.depends_on_card_id,
            )
            .join(Card, Card.id == CardDependency.card_id)
            .where(Card.board_id == board_id)
        )
        return [(row.card_id, row.depends_on_card_id) for row in result.all()]

    async def list_card_meta_for_board(
        self, board_id: uuid.UUID
    ) -> list[tuple[uuid.UUID, str, str | None]]:
        """(card_id, title, column_type) for every card on the board.

        column_type is the string value of the card's column type (or None
        for an untyped column). Powers whole-board validation: cycle node
        labels + done-column conflict detection without an N+1 fetch.
        """
        result = await self.db.execute(
            select(Card.id, Card.title, Column.column_type)
            .join(Column, Column.id == Card.column_id)
            .where(Card.board_id == board_id)
        )
        return [
            (
                row.id,
                row.title,
                row.column_type.value if row.column_type is not None else None,
            )
            for row in result.all()
        ]

    @staticmethod
    def _to_edge(row) -> DependencyEdge:
        return DependencyEdge(
            card_id=row.card_id,
            depends_on_card_id=row.depends_on_card_id,
            created_at=row.created_at,
            created_by=row.created_by,
            depends_on_title=row.title,
            depends_on_status=row.status,
            depends_on_column_type=(
                row.column_type.value if row.column_type is not None else None
            ),
        )

    async def card_in_workspace(
        self, card_id: uuid.UUID, workspace_id: uuid.UUID, board_id: uuid.UUID | None = None
    ) -> bool:
        from app.models.kanban.board import Board

        query = select(Card.id).join(Board, Card.board_id == Board.id).where(Card.id == card_id, Board.workspace_id == workspace_id)
        if board_id is not None:
            query = query.where(Card.board_id == board_id)
        result = await self.db.execute(query)
        return result.scalar_one_or_none() is not None
