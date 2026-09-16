# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DEP-3: HTTP integration tests for /cards/{id}/dependencies."""

from __future__ import annotations

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User


BASE = "/api/workspaces/default/boards"


def _deps_url(board: Board, card_id: uuid.UUID, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/cards/{card_id}/dependencies{suffix}"


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


async def test_post_dependency_creates_edge(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")

    resp = await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )

    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["card_id"] == str(a.id)
    assert body["depends_on_card_id"] == str(b.id)


async def test_post_dependency_is_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")

    first = await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )
    second = await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )
    assert first.status_code == 201
    # Idempotent re-add returns 200 with the existing row (mirrors
    # add_card_participant, [[feedback_idempotent_mutations]]).
    assert second.status_code == 200, second.text
    assert second.json()["created_at"] == first.json()["created_at"]


async def test_post_dependency_rejects_self_dep(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")

    resp = await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(a.id)},
    )
    assert resp.status_code == 422
    assert resp.json()["error_code"] == "validation_error"


async def test_post_dependency_rejects_cycle(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")

    await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )
    resp = await client.post(
        _deps_url(test_board, b.id),
        json={"depends_on_card_id": str(a.id)},
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["error_code"] == "cycle_detected"


async def test_post_dependency_404_for_unknown_card(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")

    resp = await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(uuid.uuid4())},
    )
    assert resp.status_code == 404


async def test_get_dependencies_returns_bidirectional_view(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")

    await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )
    await client.post(
        _deps_url(test_board, c.id),
        json={"depends_on_card_id": str(a.id)},
    )

    resp = await client.get(_deps_url(test_board, a.id))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {d["depends_on_card_id"] for d in body["depends_on"]} == {str(b.id)}
    assert {d["card_id"] for d in body["blocks"]} == {str(c.id)}


async def test_delete_dependency_is_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )

    resp = await client.delete(_deps_url(test_board, a.id, f"/{b.id}"))
    assert resp.status_code == 204
    # Second delete is a no-op success.
    resp = await client.delete(_deps_url(test_board, a.id, f"/{b.id}"))
    assert resp.status_code == 204


async def test_put_bulk_set_replaces_atomically(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")
    d = await _seed_card(db_session, test_board, test_column, test_user, "D")
    await client.post(
        _deps_url(test_board, a.id),
        json={"depends_on_card_id": str(b.id)},
    )

    resp = await client.put(
        _deps_url(test_board, a.id),
        json={"depends_on_card_ids": [str(c.id), str(d.id)]},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert {dep["depends_on_card_id"] for dep in body["depends_on"]} == {
        str(c.id),
        str(d.id),
    }
