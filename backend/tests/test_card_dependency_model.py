# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DEP-1: CardDependency model schema invariants.

Migration + Pydantic + service layers live in DEP-2 and onward — this file
pins the model shape only: PK is composite, CHECK rejects self-deps, FK
cascades both sides.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column
from app.models.user import User


async def _make_card(db: AsyncSession, board: Board, column: Column, user: User, title: str) -> Card:
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


@pytest.mark.asyncio
async def test_card_dependency_inserts(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    dep = CardDependency(
        card_id=a.id, depends_on_card_id=b.id, created_by=test_user.id
    )
    db_session.add(dep)
    await db_session.flush()

    rows = (await db_session.execute(select(CardDependency))).scalars().all()
    assert len(rows) == 1
    assert rows[0].card_id == a.id
    assert rows[0].depends_on_card_id == b.id
    assert rows[0].created_at is not None


@pytest.mark.asyncio
async def test_card_dependency_rejects_self_dependency(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    dep = CardDependency(
        card_id=a.id, depends_on_card_id=a.id, created_by=test_user.id
    )
    db_session.add(dep)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_card_dependency_composite_pk_idempotency(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Same (card_id, depends_on_card_id) pair must not insert twice."""
    a = await _make_card(db_session, test_board, test_column, test_user, "A")
    b = await _make_card(db_session, test_board, test_column, test_user, "B")
    db_session.add(
        CardDependency(card_id=a.id, depends_on_card_id=b.id, created_by=test_user.id)
    )
    await db_session.flush()
    db_session.add(
        CardDependency(card_id=a.id, depends_on_card_id=b.id, created_by=test_user.id)
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.asyncio
async def test_card_dependency_fk_definitions_carry_cascade(
    db_session: AsyncSession,
):
    """Model declares ON DELETE CASCADE on both FKs so Postgres unblocks
    dependents when a prerequisite is deleted. Asserted at the schema level
    because SQLite tests don't enforce FK cascade by default."""
    table = CardDependency.__table__
    fk_targets = {fk.column.table.name: fk.ondelete for fk in table.foreign_keys}
    assert fk_targets.get("cards") == "CASCADE"
    # Both card-FKs target the same cards table; both must declare CASCADE.
    cascades = [fk.ondelete for fk in table.foreign_keys if fk.column.table.name == "cards"]
    assert cascades == ["CASCADE", "CASCADE"], (
        f"expected both card FKs to declare CASCADE; got {cascades!r}"
    )
