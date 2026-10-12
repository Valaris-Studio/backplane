# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every card response names the column it sits in (obstacle #12).

column_name/column_type were attached on search only; create, get, patch,
move, bulk, claim and participant responses returned null, so an agent had to
re-read the board to learn where a card landed.
"""

from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.user import User

BASE = "/api/workspaces/default/boards"


async def _typed_column(
    db: AsyncSession, board: Board, name: str, column_type: ColumnType, position: float
) -> Column:
    column = Column(board_id=board.id, name=name, position=position, column_type=column_type)
    db.add(column)
    await db.flush()
    return column


def _assert_labels(card: dict, column: Column) -> None:
    assert card["column_id"] == str(column.id)
    assert card["column_name"] == column.name
    assert card["column_type"] == (column.column_type.value if column.column_type else None)


async def _active_column(db_session: AsyncSession, test_board: Board) -> Column:
    return await _typed_column(db_session, test_board, "In Progress", ColumnType.active, 2048.0)


async def test_create_card_response_names_its_column(
    client: AsyncClient, db_session: AsyncSession, test_board: Board
):
    active = await _active_column(db_session, test_board)

    resp = await client.post(
        f"{BASE}/{test_board.id}/cards", json={"column_id": str(active.id), "title": "New"}
    )

    assert resp.status_code == 201, resp.text
    _assert_labels(resp.json(), active)


async def test_bulk_create_cards_response_names_each_column(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, test_column: Column
):
    active = await _active_column(db_session, test_board)

    resp = await client.post(
        f"{BASE}/{test_board.id}/cards/bulk",
        json={
            "cards": [
                {"column_id": str(active.id), "title": "A"},
                {"column_id": str(test_column.id), "title": "B"},
            ]
        },
    )

    assert resp.status_code == 201, resp.text
    cards = {card["title"]: card for card in resp.json()["cards"]}
    _assert_labels(cards["A"], active)
    _assert_labels(cards["B"], test_column)


async def test_get_card_response_names_its_column(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")

    assert resp.status_code == 200
    _assert_labels(resp.json(), test_column)


async def test_get_card_markdown_response_names_its_column(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}?format=markdown")

    assert resp.status_code == 200
    _assert_labels(resp.json(), test_column)


async def test_resolve_card_response_names_its_column(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.get(
        f"{BASE}/{test_board.id}/cards/resolve", params={"prefix": str(test_card.id)[:8]}
    )

    assert resp.status_code == 200
    _assert_labels(resp.json(), test_column)


async def test_update_card_response_names_its_column(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.patch(
        f"{BASE}/{test_board.id}/cards/{test_card.id}", json={"title": "Renamed"}
    )

    assert resp.status_code == 200
    _assert_labels(resp.json(), test_column)


async def test_move_card_response_names_the_target_column(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, test_card: Card
):
    active = await _active_column(db_session, test_board)

    resp = await client.patch(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/move", json={"column_id": str(active.id)}
    )

    assert resp.status_code == 200, resp.text
    _assert_labels(resp.json(), active)


async def test_move_card_after_a_read_names_the_target_column(
    client: AsyncClient, db_session: AsyncSession, test_board: Board, test_card: Card
):
    # A read first loads the card's column; the move must not echo that stale one.
    active = await _active_column(db_session, test_board)
    await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")

    resp = await client.patch(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/move", json={"column_id": str(active.id)}
    )

    assert resp.status_code == 200, resp.text
    _assert_labels(resp.json(), active)


async def test_participant_responses_name_the_column(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    added = await client.post(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/participants",
        json={"user_id": str(test_user.id), "role": "helper"},
    )
    assert added.status_code == 201, added.text
    _assert_labels(added.json(), test_column)

    removed = await client.delete(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/participants/{test_user.id}"
    )
    assert removed.status_code == 200, removed.text
    _assert_labels(removed.json(), test_column)


async def test_claim_card_response_names_its_column(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_agent: Agent,
):
    resp = await client.post(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/claim",
        json={"agent_id": str(test_agent.id)},
    )

    assert resp.status_code == 200, resp.text
    _assert_labels(resp.json(), test_column)


async def test_search_cards_response_still_names_each_column(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.get(f"{BASE}/{test_board.id}/cards/search")

    assert resp.status_code == 200
    _assert_labels(resp.json()[0], test_column)


async def test_board_detail_cards_name_their_column(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.get(f"{BASE}/{test_board.id}")

    assert resp.status_code == 200
    columns = {column["id"]: column for column in resp.json()["columns"]}
    _assert_labels(columns[str(test_column.id)]["cards"][0], test_column)


async def test_update_column_response_cards_carry_the_new_name(
    client: AsyncClient, test_board: Board, test_column: Column, test_card: Card
):
    resp = await client.patch(
        f"{BASE}/{test_board.id}/columns/{test_column.id}", json={"name": "Ready"}
    )

    assert resp.status_code == 200, resp.text
    card = resp.json()["cards"][0]
    assert card["column_name"] == "Ready"


async def test_card_column_labels_cost_constant_queries(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    columns = [
        await _typed_column(db_session, test_board, f"Lane {i}", ColumnType.active, 2048.0 * (i + 1))
        for i in range(6)
    ]
    for i, column in enumerate(columns):
        for j in range(3):
            db_session.add(
                Card(
                    board_id=test_board.id,
                    column_id=column.id,
                    title=f"card {i}-{j}",
                    description="",
                    position=1024.0 * (j + 1),
                    created_by=test_user.id,
                )
            )
    await db_session.flush()

    column_selects = 0
    sync_engine = db_session.get_bind()

    def _count(conn, cursor, statement, parameters, context, executemany):
        nonlocal column_selects
        lowered = statement.lower()
        if lowered.lstrip().startswith("select") and "from columns" in lowered:
            column_selects += 1

    event.listen(sync_engine, "before_cursor_execute", _count)
    try:
        resp = await client.get(f"{BASE}/{test_board.id}/cards/search")
    finally:
        event.remove(sync_engine, "before_cursor_execute", _count)

    assert resp.status_code == 200
    assert all(card["column_name"] for card in resp.json())
    # Constant in the number of cards and columns: one eager load, plus at most
    # the dependency-status target-column probe.
    assert column_selects <= 2, f"{column_selects} column SELECTs for 18 cards (N+1)"
