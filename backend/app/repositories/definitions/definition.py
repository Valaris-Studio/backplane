# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select

from app.models.definitions.definition import Definition
from app.repositories.base import BaseRepository


class DefinitionRepository(BaseRepository[Definition]):
    model = Definition

    async def get_by_board(self, board_id: uuid.UUID) -> Definition | None:
        result = await self.db.execute(
            select(Definition).where(Definition.board_id == board_id)
        )
        return result.scalar_one_or_none()

    async def board_ids_with_definition(
        self, board_ids: list[uuid.UUID]
    ) -> set[uuid.UUID]:
        if not board_ids:
            return set()
        result = await self.db.execute(
            select(Definition.board_id).where(Definition.board_id.in_(board_ids))
        )
        return set(result.scalars().all())
