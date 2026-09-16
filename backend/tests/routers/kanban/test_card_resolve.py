# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GET .../cards/resolve?prefix=... — resolve a card by UUID prefix.

Additive read-only endpoint for agents/humans who hold a short id fragment.
- Unique match  → 200 with the full CardRead.
- Zero matches  → 404.
- >1 matches    → 409 listing candidate ids + titles.
- prefix < 4    → 422.

The strict GET .../cards/{card_id} route is untouched; `resolve` must not be
shadowed by the UUID route (verified by the unique-match 200).

SQLite gotcha (test DB only): an all-numeric hyphenated UUID coerces to an
integer under SQLite's flexible typing, so `cast(id, String)` renders `'1'`
instead of hex. We use UUIDs with hex LETTERS (`aaaa…`) so SQLite stores them as
text — matching Postgres's native `uuid::text` in prod.
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


def _resolve_url(board: Board, prefix: str) -> str:
    return f"{BASE}/{board.id}/cards/resolve?prefix={prefix}"


async def _insert_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    card_id: uuid.UUID,
    title: str,
) -> Card:
    card = Card(
        id=card_id,
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def test_resolve_card_by_prefix_unique(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    cid = uuid.UUID("aaaacccc-0000-0000-0000-0000000000aa")
    await _insert_card(db_session, test_board, test_column, test_user, cid, "Only")

    # Slice a genuine prefix off the real id — guarantees a match.
    prefix = str(cid)[:12]
    response = await client.get(_resolve_url(test_board, prefix))
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(cid)
    assert data["title"] == "Only"
    # Full CardRead shape (participants present in the payload).
    assert "participants" in data


async def test_resolve_card_by_prefix_ambiguous(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    c1 = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a1")
    c2 = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a2")
    await _insert_card(db_session, test_board, test_column, test_user, c1, "First")
    await _insert_card(db_session, test_board, test_column, test_user, c2, "Second")

    response = await client.get(_resolve_url(test_board, "aaaa000"))
    assert response.status_code == 409
    detail = response.json()["detail"]
    # Candidate ids + titles are listed so the caller can disambiguate.
    assert str(c1) in detail
    assert str(c2) in detail
    assert "First" in detail
    assert "Second" in detail


async def test_resolve_card_by_prefix_none(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.get(_resolve_url(test_board, "deadbeef"))
    assert response.status_code == 404


async def test_resolve_card_by_prefix_too_short(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    response = await client.get(_resolve_url(test_board, "abc"))
    assert response.status_code == 422


async def test_resolve_does_not_shadow_strict_get_by_uuid(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    # The strict GET .../cards/{card_id} route still resolves a full UUID.
    cid = uuid.UUID("bbbb2222-0000-0000-0000-0000000000b1")
    await _insert_card(db_session, test_board, test_column, test_user, cid, "Strict")

    response = await client.get(f"{BASE}/{test_board.id}/cards/{cid}")
    assert response.status_code == 200
    assert response.json()["id"] == str(cid)
