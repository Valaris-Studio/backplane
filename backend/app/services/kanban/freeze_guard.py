# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Frozen-board mutation gate, shared by every board-scoped service.

Standalone module (models + exceptions only) so notes/resources/git/definition
services can import it without pulling in the kanban service graph.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import BoardFrozenError
from app.models.kanban.board import Board


async def assert_board_not_frozen(
    db: AsyncSession, board_id: uuid.UUID | None
) -> None:
    """Raise BoardFrozenError (409) when `board_id` points at a frozen board.

    No-op for None (workspace-scoped entities) and for nonexistent ids —
    several runner paths persist unvalidated board ids today, and the gate
    must not change their behavior.
    """
    if board_id is None:
        return
    is_frozen = await db.scalar(
        select(Board.is_frozen).where(Board.id == board_id)
    )
    if is_frozen:
        raise BoardFrozenError()
