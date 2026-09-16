# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from sqlalchemy import select

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column
from app.models.kanban.completion import CompletionCandidate
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig


class CompletionDependencyRepository:
    def __init__(self, db):
        self.db = db

    async def edges(self, *, card_ids=None, board_id=None, workspace_id=None):
        query = (
            select(CardDependency.card_id, CardDependency.depends_on_card_id)
            .join(
                Card,
                Card.id == CardDependency.card_id,
            )
            .join(Board, Board.id == Card.board_id)
        )
        if card_ids is not None:
            query = query.where(Card.id.in_(card_ids))
        if board_id is not None:
            query = query.where(Board.id == board_id)
        if workspace_id is not None:
            query = query.where(Board.workspace_id == workspace_id)
        return list(
            (
                await self.db.execute(query.execution_options(populate_existing=True))
            ).all()
        )

    async def cards(
        self,
        *,
        card_ids=None,
        board_id=None,
        workspace_id=None,
        accepted_only=False,
        fresh=False,
    ):
        query = (
            select(Card, Board, Column.column_type)
            .join(Board, Board.id == Card.board_id)
            .join(Column, Column.id == Card.column_id)
        )
        if card_ids is not None:
            query = query.where(Card.id.in_(card_ids))
        if board_id is not None:
            query = query.where(Board.id == board_id)
        if workspace_id is not None:
            query = query.where(Board.workspace_id == workspace_id)
        if accepted_only:
            query = query.join(
                CompletionCandidate, CompletionCandidate.card_id == Card.id
            ).where(
                CompletionCandidate.is_current.is_(True),
                CompletionCandidate.status == "accepted",
            )
        return list(
            (
                await self.db.execute(query.execution_options(populate_existing=fresh))
            ).all()
        )

    async def workspace_for_board(self, board_id):
        return await self.db.scalar(
            select(Board.workspace_id).where(Board.id == board_id)
        )

    async def lock_workspace(self, workspace_id):
        await self.db.execute(
            select(Workspace.id).where(Workspace.id == workspace_id).with_for_update()
        )
        await self.db.execute(
            select(WorkspaceConfig)
            .where(WorkspaceConfig.workspace_id == workspace_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    async def lock_cards(self, workspace_id, card_ids):
        board_ids = select(Card.board_id).where(Card.id.in_(card_ids))
        await self.db.execute(
            select(Board)
            .where(Board.workspace_id == workspace_id, Board.id.in_(board_ids))
            .order_by(Board.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        await self.db.execute(
            select(Card)
            .join(Board, Board.id == Card.board_id)
            .where(Board.workspace_id == workspace_id, Card.id.in_(card_ids))
            .order_by(Card.id)
            .with_for_update(of=Card)
            .execution_options(populate_existing=True)
        )
        await self.db.execute(
            select(CompletionCandidate)
            .where(
                CompletionCandidate.workspace_id == workspace_id,
                CompletionCandidate.card_id.in_(card_ids),
                CompletionCandidate.is_current.is_(True),
            )
            .order_by(CompletionCandidate.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
