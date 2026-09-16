# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board-level dependency edge listing for the kanban tree view.

GET /api/workspaces/{slug}/boards/{board_id}/dependencies returns every
dependency edge on the board in a single call, so the frontend can build the
within-column dependency tree without an N+1 fetch per card.
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column
from app.models.user import User


BASE = "/api/workspaces/default/boards"


async def _seed_card(
    db: AsyncSession, board: Board, column: Column, user: User, title: str
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def _seed_edge(
    db: AsyncSession, card: Card, depends_on: Card, user: User
) -> None:
    db.add(
        CardDependency(
            card_id=card.id,
            depends_on_card_id=depends_on.id,
            created_by=user.id,
        )
    )
    await db.flush()


async def test_list_board_dependencies_returns_all_edges(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")
    # A depends on B, B depends on C.
    await _seed_edge(db_session, a, b, test_user)
    await _seed_edge(db_session, b, c, test_user)

    resp = await client.get(f"{BASE}/{test_board.id}/dependencies")

    assert resp.status_code == 200, resp.text
    edges = resp.json()
    pairs = {(e["card_id"], e["depends_on_card_id"]) for e in edges}
    assert pairs == {
        (str(a.id), str(b.id)),
        (str(b.id), str(c.id)),
    }


async def test_list_board_dependencies_empty_when_none(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    await _seed_card(db_session, test_board, test_column, test_user, "lonely")

    resp = await client.get(f"{BASE}/{test_board.id}/dependencies")

    assert resp.status_code == 200, resp.text
    assert resp.json() == []


async def test_list_board_dependencies_scoped_to_board(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    # Edge on the test board.
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    await _seed_edge(db_session, a, b, test_user)

    # A second board in the same workspace with its own edge — must not leak.
    other = Board(
        workspace_id=test_board.workspace_id,
        name="Other",
        slug="other-board",
        description="",
        created_by=test_user.id,
    )
    db_session.add(other)
    await db_session.flush()
    other_col = Column(
        board_id=other.id, name="Col", position=1024.0
    )
    db_session.add(other_col)
    await db_session.flush()
    x = await _seed_card(db_session, other, other_col, test_user, "X")
    y = await _seed_card(db_session, other, other_col, test_user, "Y")
    await _seed_edge(db_session, x, y, test_user)

    resp = await client.get(f"{BASE}/{test_board.id}/dependencies")

    assert resp.status_code == 200, resp.text
    pairs = {(e["card_id"], e["depends_on_card_id"]) for e in resp.json()}
    assert pairs == {(str(a.id), str(b.id))}


async def test_list_board_dependencies_unknown_board_404(
    client: AsyncClient,
):
    resp = await client.get(f"{BASE}/{uuid.uuid4()}/dependencies")
    assert resp.status_code == 404, resp.text
