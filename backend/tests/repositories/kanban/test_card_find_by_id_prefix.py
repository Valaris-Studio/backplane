# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Prefix lookup for the card-resolve endpoint.

`find_by_id_prefix(board_id, prefix)` matches cards whose UUID (rendered
lowercase) starts with the given hex prefix, scoped to a board via the
denormalized `board_id`. Results are capped and eager-load participants so the
service can return a full CardRead on a unique match.

SQLite gotcha: the test DB's `UUID` column is flexibly typed, so an all-numeric
hyphenated UUID like `00000000-...-000000000001` is coerced to the integer `1`
and `cast(id, String)` renders `'1'` (not the hex text). We therefore use UUIDs
containing hex LETTERS (`aaaa…`), which SQLite stores as text — exactly what
Postgres's native `uuid::text` produces in prod. The cast+LIKE logic is
identical across dialects; only the fixture id shape must avoid numeric coercion.
"""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.repositories.kanban.card import CardRepository


async def _make_card(
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


async def test_find_by_id_prefix_returns_matching_card(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    cid = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a1")
    await _make_card(db_session, test_board, test_column, test_user, cid, "A")

    repo = CardRepository(db_session)
    matches = await repo.find_by_id_prefix(test_board.id, "aaaa0000")

    assert [c.id for c in matches] == [cid]


async def test_find_by_id_prefix_returns_all_sharing_prefix(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    c1 = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a1")
    c2 = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a2")
    await _make_card(db_session, test_board, test_column, test_user, c1, "A")
    await _make_card(db_session, test_board, test_column, test_user, c2, "B")

    repo = CardRepository(db_session)
    matches = await repo.find_by_id_prefix(test_board.id, "aaaa000")

    assert {c.id for c in matches} == {c1, c2}


async def test_find_by_id_prefix_is_case_insensitive(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    cid = uuid.UUID("abcdef00-0000-0000-0000-000000000001")
    await _make_card(db_session, test_board, test_column, test_user, cid, "A")

    repo = CardRepository(db_session)
    # Uppercase prefix must still match the lowercase-rendered UUID.
    matches = await repo.find_by_id_prefix(test_board.id, "ABCDEF")

    assert [c.id for c in matches] == [cid]


async def test_find_by_id_prefix_scoped_to_board(
    db_session: AsyncSession,
    test_workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    # A card on another board sharing the prefix must NOT be returned.
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    other_col = Column(board_id=other_board.id, name="C", position=1024.0)
    db_session.add(other_col)
    await db_session.flush()

    mine = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a1")
    theirs = uuid.UUID("aaaa0000-0000-0000-0000-0000000000a2")
    await _make_card(db_session, test_board, test_column, test_user, mine, "Mine")
    await _make_card(db_session, other_board, other_col, test_user, theirs, "Theirs")

    repo = CardRepository(db_session)
    matches = await repo.find_by_id_prefix(test_board.id, "aaaa000")

    assert [c.id for c in matches] == [mine]


async def test_find_by_id_prefix_eager_loads_participants(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    cid = uuid.UUID("bbbb1111-0000-0000-0000-0000000000c1")
    await _make_card(db_session, test_board, test_column, test_user, cid, "A")

    repo = CardRepository(db_session)
    matches = await repo.find_by_id_prefix(test_board.id, "bbbb1111")

    # participants is eager-loaded (no MissingGreenlet on access post-fetch).
    assert matches[0].participants == []
