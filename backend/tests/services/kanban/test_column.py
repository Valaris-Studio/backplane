# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.schemas.kanban.column import ColumnCreate, ColumnUpdate
from app.services.kanban.column import ColumnService


async def test_create_column(db_session: AsyncSession, test_board: Board):
    service = ColumnService(db_session)
    data = ColumnCreate(name="Review", color="#f59e0b")

    column = await service.create_column(test_board.id, data)

    assert column.name == "Review"
    assert column.color == "#f59e0b"
    assert column.board_id == test_board.id


async def test_create_column_auto_positions(db_session: AsyncSession, test_board: Board):
    service = ColumnService(db_session)

    col1 = await service.create_column(test_board.id, ColumnCreate(name="A"))
    col2 = await service.create_column(test_board.id, ColumnCreate(name="B"))

    assert col2.position > col1.position
    assert col2.position - col1.position == 1024.0


async def test_create_column_first_in_empty_board(
    db_session: AsyncSession, test_board: Board
):
    service = ColumnService(db_session)

    column = await service.create_column(test_board.id, ColumnCreate(name="First"))

    assert column.position == 1024.0


async def test_update_column(
    db_session: AsyncSession, test_board: Board, test_column: Column
):
    service = ColumnService(db_session)
    data = ColumnUpdate(name="Renamed", color="#ef4444")

    updated = await service.update_column(test_column.id, test_board.id, data)

    assert updated.name == "Renamed"
    assert updated.color == "#ef4444"


async def test_update_column_partial(
    db_session: AsyncSession, test_board: Board, test_column: Column
):
    service = ColumnService(db_session)
    original_color = test_column.color
    data = ColumnUpdate(name="Only Name")

    updated = await service.update_column(test_column.id, test_board.id, data)

    assert updated.name == "Only Name"
    assert updated.color == original_color


async def test_update_column_can_clear_column_type(
    db_session: AsyncSession, test_board: Board
):
    """Explicit None on column_type CLEARS the type.

    Regression for the quiet bug in ColumnRepository.update that dropped
    None values — making typed columns impossible to convert into the
    human-only "untyped" zone the platform invariant calls for.
    """
    service = ColumnService(db_session)
    typed = await service.create_column(
        test_board.id, ColumnCreate(name="Backlog", column_type="backlog")
    )
    assert typed.column_type is not None

    updated = await service.update_column(
        typed.id, test_board.id, ColumnUpdate(column_type=None)
    )

    assert updated.column_type is None


async def test_update_column_not_found(db_session: AsyncSession, test_board: Board):
    service = ColumnService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_column(uuid.uuid4(), test_board.id, ColumnUpdate(name="X"))


async def test_update_column_wrong_board(
    db_session: AsyncSession, test_column: Column
):
    service = ColumnService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_column(
            test_column.id, uuid.uuid4(), ColumnUpdate(name="X")
        )


async def test_delete_column(db_session: AsyncSession, test_board: Board):
    service = ColumnService(db_session)
    column = await service.create_column(test_board.id, ColumnCreate(name="Delete Me"))

    await service.delete_column(column.id, test_board.id)

    with pytest.raises(ResourceNotFoundError):
        await service.update_column(column.id, test_board.id, ColumnUpdate(name="X"))


async def test_delete_column_not_found(db_session: AsyncSession, test_board: Board):
    service = ColumnService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_column(uuid.uuid4(), test_board.id)


async def test_delete_column_wrong_board(
    db_session: AsyncSession, test_column: Column
):
    service = ColumnService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_column(test_column.id, uuid.uuid4())


async def test_reorder_columns(db_session: AsyncSession, test_board: Board):
    service = ColumnService(db_session)
    col_a = await service.create_column(test_board.id, ColumnCreate(name="A"))
    col_b = await service.create_column(test_board.id, ColumnCreate(name="B"))
    col_c = await service.create_column(test_board.id, ColumnCreate(name="C"))

    # Reverse order
    await service.reorder_columns(test_board.id, [col_c.id, col_b.id, col_a.id])

    assert col_c.position == 1024.0
    assert col_b.position == 2048.0
    assert col_a.position == 3072.0
