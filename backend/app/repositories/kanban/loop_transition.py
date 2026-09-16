# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.models.kanban.loop_transition import BoardLoopTransition
from app.repositories.base import BaseRepository


class BoardLoopTransitionRepository(BaseRepository[BoardLoopTransition]):
    model = BoardLoopTransition

    async def list_for_board(
        self, board_id: uuid.UUID, limit: int, offset: int
    ) -> list[BoardLoopTransition]:
        """Newest first — the timeline is read from the most recent stop
        backwards, never forwards from the board's creation.

        `id` breaks ties on occurred_at: rows written in the same second (the
        SQLite test DB's resolution, and possible in prod when a rail stop
        follows an enable immediately) would otherwise page
        non-deterministically and could repeat or skip across pages.
        """
        result = await self.db.execute(
            select(BoardLoopTransition)
            .where(BoardLoopTransition.board_id == board_id)
            .options(
                selectinload(BoardLoopTransition.actor),
                selectinload(BoardLoopTransition.agent),
            )
            .order_by(
                BoardLoopTransition.occurred_at.desc(),
                BoardLoopTransition.id.desc(),
            )
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())

    async def count_for_board(self, board_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count())
            .select_from(BoardLoopTransition)
            .where(BoardLoopTransition.board_id == board_id)
        )
        return int(result.scalar_one())

    async def last_stop_for_board(
        self, board_id: uuid.UUID
    ) -> BoardLoopTransition | None:
        """The most recent DISABLE, regardless of what came after it — this is
        what keeps a stop reason readable once the loop is running again."""
        result = await self.db.execute(
            select(BoardLoopTransition)
            .where(
                BoardLoopTransition.board_id == board_id,
                BoardLoopTransition.enabled.is_(False),
            )
            .order_by(
                BoardLoopTransition.occurred_at.desc(),
                BoardLoopTransition.id.desc(),
            )
            .limit(1)
        )
        return result.scalar_one_or_none()
