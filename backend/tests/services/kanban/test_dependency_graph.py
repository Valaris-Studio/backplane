# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DependencyGraphService.validate — whole-board DAG validation.

Kahn topological sort for cycle detection, plus done-column conflict and
dangling-edge (orphan) checks. Mirrors the add-time guard in
DependencyService but operates on the entire board in Python, not SQL.
"""

from __future__ import annotations

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.services.kanban.dependency_graph import DependencyGraphService


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


async def _seed_column(
    db: AsyncSession, board: Board, name: str, column_type: ColumnType | None
) -> Column:
    column = Column(
        board_id=board.id, name=name, position=1024.0, column_type=column_type
    )
    db.add(column)
    await db.flush()
    return column


async def test_validate_empty_board_is_ok(
    db_session: AsyncSession, test_board: Board
):
    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is True
    assert result.cycles == []
    assert result.conflicts == []
    assert result.orphans == []


async def test_validate_linear_chain_is_ok(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")
    await _seed_edge(db_session, a, b, test_user)
    await _seed_edge(db_session, b, c, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is True
    assert result.cycles == []


async def test_validate_diamond_is_not_a_cycle(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    # D depends on B and C; both depend on A. Multi-parent, but acyclic.
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")
    d = await _seed_card(db_session, test_board, test_column, test_user, "D")
    await _seed_edge(db_session, b, a, test_user)
    await _seed_edge(db_session, c, a, test_user)
    await _seed_edge(db_session, d, b, test_user)
    await _seed_edge(db_session, d, c, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is True
    assert result.cycles == []


async def test_validate_simple_two_cycle_detected(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    await _seed_edge(db_session, a, b, test_user)
    await _seed_edge(db_session, b, a, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is False
    assert len(result.cycles) == 1
    members = set(result.cycles[0].card_ids)
    assert members == {a.id, b.id}


async def test_validate_two_independent_cycles_detected(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")
    d = await _seed_card(db_session, test_board, test_column, test_user, "D")
    # Cycle 1: A <-> B. Cycle 2: C <-> D. No edges between the two.
    await _seed_edge(db_session, a, b, test_user)
    await _seed_edge(db_session, b, a, test_user)
    await _seed_edge(db_session, c, d, test_user)
    await _seed_edge(db_session, d, c, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is False
    assert len(result.cycles) == 2
    member_sets = {frozenset(c.card_ids) for c in result.cycles}
    assert member_sets == {frozenset({a.id, b.id}), frozenset({c.id, d.id})}


async def test_validate_three_node_cycle_detected(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    c = await _seed_card(db_session, test_board, test_column, test_user, "C")
    await _seed_edge(db_session, a, b, test_user)
    await _seed_edge(db_session, b, c, test_user)
    await _seed_edge(db_session, c, a, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is False
    assert len(result.cycles) == 1
    assert set(result.cycles[0].card_ids) == {a.id, b.id, c.id}


async def test_validate_done_card_with_not_done_dep_is_conflict(
    db_session: AsyncSession, test_board: Board, test_user: User
):
    done_col = await _seed_column(db_session, test_board, "Done", ColumnType.done)
    active_col = await _seed_column(
        db_session, test_board, "Active", ColumnType.active
    )
    done_card = await _seed_card(db_session, test_board, done_col, test_user, "shipped")
    pending = await _seed_card(db_session, test_board, active_col, test_user, "pending")
    # The done card depends on a card that is NOT done — a real conflict.
    await _seed_edge(db_session, done_card, pending, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is False
    assert len(result.conflicts) == 1
    conflict = result.conflicts[0]
    assert conflict.card_id == done_card.id
    assert pending.id in conflict.unsatisfied_dependency_ids


async def test_validate_done_card_with_done_dep_is_clean(
    db_session: AsyncSession, test_board: Board, test_user: User
):
    done_col = await _seed_column(db_session, test_board, "Done", ColumnType.done)
    done_a = await _seed_card(db_session, test_board, done_col, test_user, "A")
    done_b = await _seed_card(db_session, test_board, done_col, test_user, "B")
    await _seed_edge(db_session, done_a, done_b, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is True
    assert result.conflicts == []


async def test_validate_not_done_card_with_not_done_dep_is_clean(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _seed_card(db_session, test_board, test_column, test_user, "A")
    b = await _seed_card(db_session, test_board, test_column, test_user, "B")
    await _seed_edge(db_session, a, b, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is True
    assert result.conflicts == []


async def test_validate_cross_board_dangling_edge_is_orphan(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    on_board = await _seed_card(db_session, test_board, test_column, test_user, "here")

    # A card on a different board, then an edge from on_board -> that card.
    other = Board(
        workspace_id=test_board.workspace_id,
        name="Other",
        slug="other-board",
        description="",
        created_by=test_user.id,
    )
    db_session.add(other)
    await db_session.flush()
    other_col = await _seed_column(db_session, other, "Col", ColumnType.active)
    off_board = await _seed_card(db_session, other, other_col, test_user, "elsewhere")
    await _seed_edge(db_session, on_board, off_board, test_user)

    result = await DependencyGraphService(db_session).validate(
        board_id=test_board.id
    )
    assert result.ok is False
    assert len(result.orphans) == 1
    orphan = result.orphans[0]
    assert orphan.card_id == on_board.id
    assert orphan.depends_on_card_id == off_board.id
