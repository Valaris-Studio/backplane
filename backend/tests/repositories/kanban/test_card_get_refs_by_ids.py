# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Batch title/board_id lookup for card references.

`get_refs_by_ids` resolves a set of card UUIDs to {id: (title, board_id)} in a
single scalar tuple-select — the batch primitive that lets ExecutionService and
ActivityService enrich cards_affected / entity_title without N+1.
"""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories.kanban.card import CardRepository


async def test_get_refs_by_ids_returns_title_and_board_id(
    db_session: AsyncSession, test_card: Card, test_board: Board
):
    repo = CardRepository(db_session)
    refs = await repo.get_refs_by_ids({test_card.id})

    assert refs == {test_card.id: (test_card.title, test_board.id)}


async def test_get_refs_by_ids_empty_input_returns_empty_no_query(
    db_session: AsyncSession,
):
    repo = CardRepository(db_session)
    refs = await repo.get_refs_by_ids(set())
    assert refs == {}


async def test_get_refs_by_ids_omits_missing_ids(
    db_session: AsyncSession, test_card: Card
):
    repo = CardRepository(db_session)
    ghost = uuid.uuid4()
    refs = await repo.get_refs_by_ids({test_card.id, ghost})

    assert test_card.id in refs
    assert ghost not in refs


async def test_get_refs_by_ids_resolves_cards_across_boards_in_one_call(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    # A second board+column+card: cards_affected can reference cards on another
    # board, so the ref's board_id must be the CARD's board, resolved per-row.
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    other_column = Column(board_id=other_board.id, name="Col", position=1024.0)
    db_session.add(other_column)
    await db_session.flush()
    other_card = Card(
        board_id=other_board.id,
        column_id=other_column.id,
        title="Cross-board Card",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(other_card)
    await db_session.flush()

    refs = await repo_refs(db_session, {test_card.id, other_card.id})

    assert refs[test_card.id] == (test_card.title, test_board.id)
    assert refs[other_card.id] == (other_card.title, other_board.id)


async def repo_refs(db_session: AsyncSession, ids: set[uuid.UUID]):
    return await CardRepository(db_session).get_refs_by_ids(ids)
