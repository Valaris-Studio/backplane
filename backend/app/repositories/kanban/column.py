# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.models.kanban.card import Card, CardParticipant
from app.models.kanban.column import Column
from app.repositories.base import BaseRepository


class ColumnRepository(BaseRepository[Column]):
    model = Column

    async def get_by_id(self, id: uuid.UUID) -> Column | None:
        result = await self.db.execute(
            select(Column)
            .where(Column.id == id)
            .options(selectinload(Column.cards).selectinload(Card.participants).selectinload(CardParticipant.user), selectinload(Column.cards).selectinload(Card.participants).selectinload(CardParticipant.agent))
        )
        return result.scalar_one_or_none()

    async def create(self, **kwargs) -> Column:
        instance = Column(**kwargs)
        self.db.add(instance)
        await self.db.flush()
        return await self.get_by_id(instance.id)

    async def update(self, instance: Column, **kwargs) -> Column:
        # Caller resolves "should-update?" via ColumnUpdate.model_dump(
        # exclude_unset=True); everything we receive here is an explicit
        # intent, including None (used to CLEAR column_type). The old
        # `if value is not None` gate silently dropped legitimate clear
        # operations — e.g. nulling a typed column to take it out of the
        # agent-discovery surface (the untyped-column invariant).
        for key, value in kwargs.items():
            setattr(instance, key, value)
        await self.db.flush()
        return await self.get_by_id(instance.id)

    async def list_by_board(self, board_id: uuid.UUID) -> list[Column]:
        result = await self.db.execute(
            select(Column)
            .where(Column.board_id == board_id)
            .order_by(Column.position)
        )
        return list(result.scalars().all())

    async def get_max_position(self, board_id: uuid.UUID) -> float:
        result = await self.db.execute(
            select(func.coalesce(func.max(Column.position), 0.0)).where(
                Column.board_id == board_id
            )
        )
        return result.scalar_one()

    async def get_ids_for_board(self, board_id: uuid.UUID, column_ids: set[uuid.UUID]) -> set[uuid.UUID]:
        """Return the subset of column_ids that actually belong to the given board."""
        result = await self.db.execute(
            select(Column.id).where(
                Column.board_id == board_id,
                Column.id.in_(column_ids),
            )
        )
        return set(result.scalars().all())

    async def batch_update_positions(self, column_ids: list[uuid.UUID]) -> None:
        for i, col_id in enumerate(column_ids):
            result = await self.db.execute(select(Column).where(Column.id == col_id))
            column = result.scalar_one_or_none()
            if column:
                column.position = float((i + 1) * 1024)
        await self.db.flush()
