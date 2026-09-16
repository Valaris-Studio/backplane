# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""PATCH .../cards/{id}/move with `position` omitted appends to the target column.

A claim-style move ("put this card in In Progress") does not care where in the
column the card lands, but the request schema forced every client to invent a
float. Omitting it now follows the board's fractional-indexing convention:
max_position + 1024. Supplying a position is unchanged.
"""
import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace

BASE = "/api/workspaces/default/boards"


def _move_url(board: Board, card_id) -> str:
    return f"{BASE}/{board.id}/cards/{card_id}/move"


async def _make_column(db: AsyncSession, board: Board, name: str) -> Column:
    column = Column(id=uuid.uuid4(), board_id=board.id, name=name, position=2048.0)
    db.add(column)
    await db.flush()
    return column


async def _make_card(
    db: AsyncSession, board: Board, column: Column, user: User, position: float
) -> Card:
    card = Card(
        id=uuid.uuid4(),
        board_id=board.id,
        column_id=column.id,
        title=f"Card at {position}",
        position=position,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def test_move_without_position_appends_after_last_card(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    target = await _make_column(db_session, test_board, "Target")
    await _make_card(db_session, test_board, target, test_user, 5000.0)

    response = await client.patch(
        _move_url(test_board, test_card.id), json={"column_id": str(target.id)}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["column_id"] == str(target.id)
    assert data["position"] == 6024.0


async def test_move_without_position_into_empty_column_gets_a_sane_default(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    empty = await _make_column(db_session, test_board, "Empty")

    response = await client.patch(
        _move_url(test_board, test_card.id), json={"column_id": str(empty.id)}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["column_id"] == str(empty.id)
    assert data["position"] == 1024.0


async def test_move_with_explicit_position_is_unchanged(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    """Control: the existing explicit-position contract must not drift."""
    target = await _make_column(db_session, test_board, "Explicit")
    await _make_card(db_session, test_board, target, test_user, 5000.0)

    response = await client.patch(
        _move_url(test_board, test_card.id),
        json={"column_id": str(target.id), "position": 77.5},
    )

    assert response.status_code == 200
    assert response.json()["position"] == 77.5
