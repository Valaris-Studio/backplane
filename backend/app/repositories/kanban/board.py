# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime

from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import selectinload

from app.models.activity import Activity
from app.models.kanban.board import Board
from app.models.kanban.column import Column, ColumnType
from app.models.kanban.card import Card, CardParticipant
from app.repositories.base import BaseRepository


class BoardRepository(BaseRepository[Board]):
    model = Board

    async def list_by_workspace(self, workspace_id: uuid.UUID) -> list[Board]:
        result = await self.db.execute(
            select(Board)
            .where(Board.workspace_id == workspace_id)
            .order_by(Board.created_at.desc())
        )
        return list(result.scalars().all())

    async def list_by_workspace_with_stats(
        self, workspace_id: uuid.UUID
    ) -> list[tuple[Board, int, int, datetime | None]]:
        """Each board with its card count, column count, and last-activity
        timestamp in ONE query — same correlated-scalar-subquery shape as
        WorkspaceRepository.list_for_user_with_counts (joining cards AND columns
        would multiply rows and inflate the counts).

        last_activity_at is MAX(activities.created_at) for the board (backed by
        ix_activities_board_created); Board.updated_at only moves on board-row
        mutations, so it misses card/column edits.
        """
        card_count = (
            select(func.count(Card.id))
            .where(Card.board_id == Board.id)
            .correlate(Board)
            .scalar_subquery()
        )
        column_count = (
            select(func.count(Column.id))
            .where(Column.board_id == Board.id)
            .correlate(Board)
            .scalar_subquery()
        )
        last_activity_at = (
            select(func.max(Activity.created_at))
            .where(Activity.board_id == Board.id)
            .correlate(Board)
            .scalar_subquery()
        )
        result = await self.db.execute(
            select(Board, card_count, column_count, last_activity_at)
            .where(Board.workspace_id == workspace_id)
            .order_by(Board.created_at.desc())
        )
        return [(row[0], row[1], row[2], row[3]) for row in result.all()]

    async def card_distribution_by_workspace(
        self, workspace_id: uuid.UUID, today: date
    ) -> list[tuple[uuid.UUID, ColumnType | None, int, int]]:
        """Cards per (board, column_type) with the overdue subset, in ONE grouped
        query — the dashboard's per-board breakdown.

        Grouping on `column_type` rather than `Card.status` is deliberate:
        status is unbounded user vocabulary, column_type is the platform's
        semantic enum. NULL column_type (untyped columns) is a real bucket, kept
        as a NULL key so the caller can name it rather than silently dropping
        those cards from the board's total.

        Overdue is counted here rather than as a second query because the
        done-column exclusion needs the same join: a card whose due date has
        passed is not overdue once it has landed in a done-type column.
        """
        overdue = case(
            (
                and_(
                    Card.due_date.is_not(None),
                    Card.due_date < today,
                    Column.column_type != ColumnType.done,
                ),
                1,
            ),
            else_=0,
        )
        result = await self.db.execute(
            select(
                Card.board_id,
                Column.column_type,
                func.count(Card.id),
                func.coalesce(func.sum(overdue), 0),
            )
            .join(Column, Card.column_id == Column.id)
            .where(Card.board_id.in_(select(Board.id).where(Board.workspace_id == workspace_id)))
            .group_by(Card.board_id, Column.column_type)
        )
        return [(row[0], row[1], row[2], row[3]) for row in result.all()]

    async def count_by_workspace(self, workspace_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Board).where(Board.workspace_id == workspace_id)
        )
        return result.scalar_one()

    async def count_cards_by_workspace(self, workspace_id: uuid.UUID) -> int:
        result = await self.db.execute(
            select(func.count()).select_from(Card).where(Card.board_id.in_(
                select(Board.id).where(Board.workspace_id == workspace_id)
            ))
        )
        return result.scalar_one()

    async def get_by_slug(self, workspace_id: uuid.UUID, slug: str) -> Board | None:
        result = await self.db.execute(
            select(Board).where(
                Board.workspace_id == workspace_id, Board.slug == slug
            )
        )
        return result.scalar_one_or_none()

    async def slug_exists(
        self,
        workspace_id: uuid.UUID,
        slug: str,
        exclude_id: uuid.UUID | None = None,
    ) -> bool:
        stmt = select(Board.id).where(
            Board.workspace_id == workspace_id, Board.slug == slug
        )
        if exclude_id is not None:
            stmt = stmt.where(Board.id != exclude_id)
        result = await self.db.execute(stmt)
        return result.first() is not None

    async def get_done_merge_gate_override(self, board_id: uuid.UUID) -> bool | None:
        """Tri-state gate override as a scalar — NULL means "inherit workspace".

        Deliberately not `get_by_id`: the done-gate runs on every agent move
        into Done and only needs this one column.
        """
        result = await self.db.execute(
            select(Board.enforce_done_merge_gate).where(Board.id == board_id)
        )
        return result.scalar_one_or_none()

    async def get_full_board(self, board_id: uuid.UUID) -> Board | None:
        result = await self.db.execute(
            select(Board)
            .where(Board.id == board_id)
            .options(
                selectinload(Board.columns).selectinload(Column.cards).selectinload(Card.participants).selectinload(CardParticipant.user),
                selectinload(Board.columns).selectinload(Column.cards).selectinload(Card.participants).selectinload(CardParticipant.agent),
            )
        )
        return result.scalar_one_or_none()
