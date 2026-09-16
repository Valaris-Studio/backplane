# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.workspace_config import WorkspaceConfig
from app.models.workspace import Workspace


class CompletionRepository:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def lock_workspace(self, workspace_id: uuid.UUID):
        return await self.db.scalar(
            select(Workspace)
            .where(
                Workspace.id == workspace_id,
            )
            .with_for_update()
        )

    async def board(
        self, board_id: uuid.UUID, workspace_id: uuid.UUID | None = None, *, lock=False
    ):
        stmt = select(Board).where(Board.id == board_id)
        if workspace_id is not None:
            stmt = stmt.where(Board.workspace_id == workspace_id)
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(stmt)

    async def workspace_config(self, workspace_id: uuid.UUID, *, lock=False):
        stmt = select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == workspace_id
        )
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(stmt)

    async def inheriting_boards(self, workspace_id: uuid.UUID):
        # Python handles both historical JSON null and SQL NULL identically.
        boards = await self.boards(workspace_id, lock=True)
        return [board for board in boards if board.completion_policy is None]

    async def boards(self, workspace_id: uuid.UUID, *, lock=False):
        stmt = select(Board).where(Board.workspace_id == workspace_id).order_by(Board.id)
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return (await self.db.scalars(stmt)).all()

    async def card(self, card_id: uuid.UUID, board_id: uuid.UUID, *, lock=False):
        stmt = select(Card).where(Card.id == card_id, Card.board_id == board_id)
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        return await self.db.scalar(stmt)

    async def column_cards(self, column_id: uuid.UUID):
        return list(
            (
                await self.db.scalars(select(Card).where(Card.column_id == column_id))
            ).all()
        )

    async def update_policy(self, board: Board, policy: dict | None):
        board.completion_policy = policy
        await self.db.flush()
        await self.db.refresh(board)

    async def update_mode(self, card: Card, mode: str):
        card.completion_mode = mode
        await self.db.flush()
        await self.db.refresh(card)
