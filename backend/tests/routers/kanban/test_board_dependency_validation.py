# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GET /api/workspaces/{slug}/boards/{board_id}/dependencies/validation.

Whole-board dependency validation: cycles, done-column conflicts, dangling
(orphan) edges. Mirrors the auth/board-resolution of the sibling listing
endpoint.
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
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


async def test_validation_clean_board_returns_ok_true(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    await _seed_edge(db_session, a, b, test_user)

    resp = await client.get(f"{BASE}/{test_board.id}/dependencies/validation")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["cycles"] == []
    assert body["conflicts"] == []
    assert body["orphans"] == []


async def test_validation_cycle_returns_ok_false_with_members(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    await _seed_edge(db_session, a, b, test_user)
    await _seed_edge(db_session, b, a, test_user)

    resp = await client.get(f"{BASE}/{test_board.id}/dependencies/validation")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert len(body["cycles"]) == 1
    members = set(body["cycles"][0]["card_ids"])
    assert members == {str(a.id), str(b.id)}
    assert body["cycles"][0]["summary"]


async def test_validation_done_conflict_reported(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    done_col = Column(
        board_id=test_board.id, name="Done", position=1.0, column_type=ColumnType.done
    )
    active_col = Column(
        board_id=test_board.id, name="Active", position=2.0, column_type=ColumnType.active
    )
    db_session.add_all([done_col, active_col])
    await db_session.flush()
    done_card = await _seed_card(db_session, test_board, done_col, test_user, "shipped")
    pending = await _seed_card(db_session, test_board, active_col, test_user, "pending")
    await _seed_edge(db_session, done_card, pending, test_user)

    resp = await client.get(f"{BASE}/{test_board.id}/dependencies/validation")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is False
    assert len(body["conflicts"]) == 1
    assert body["conflicts"][0]["card_id"] == str(done_card.id)
    assert str(pending.id) in body["conflicts"][0]["unsatisfied_dependency_ids"]


async def test_validation_unknown_board_404(client: AsyncClient):
    resp = await client.get(f"{BASE}/{uuid.uuid4()}/dependencies/validation")
    assert resp.status_code == 404, resp.text
