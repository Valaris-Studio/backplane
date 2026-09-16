# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Per-board stats on the workspace summary — the dashboard's board breakdown.

Distribution keys on `column_type` (the platform's semantic enum), never on the
free-text `Card.status`: status is unbounded user vocabulary. Columns may carry
a NULL column_type, so the distribution needs an explicit `untyped` bucket
rather than silently dropping those cards from the totals.
"""

from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/summary"


def _board(workspace: Workspace, user: User, name: str) -> Board:
    return Board(workspace_id=workspace.id, name=name, created_by=user.id)


def _column(board: Board, name: str, column_type: ColumnType | None) -> Column:
    return Column(board_id=board.id, name=name, position=1024.0, column_type=column_type)


def _card(board: Board, column: Column, user: User, title: str, due_date: date | None = None) -> Card:
    return Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=1024.0,
        created_by=user.id,
        due_date=due_date,
    )


async def test_summary_reports_card_distribution_per_board(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    board = _board(test_workspace, test_user, "Delivery")
    db_session.add(board)
    await db_session.flush()

    backlog = _column(board, "To Do", ColumnType.backlog)
    active = _column(board, "In Progress", ColumnType.active)
    done = _column(board, "Done", ColumnType.done)
    db_session.add_all([backlog, active, done])
    await db_session.flush()

    db_session.add_all(
        [
            _card(board, backlog, test_user, "b1"),
            _card(board, backlog, test_user, "b2"),
            _card(board, active, test_user, "a1"),
            _card(board, done, test_user, "d1"),
            _card(board, done, test_user, "d2"),
            _card(board, done, test_user, "d3"),
        ]
    )
    await db_session.flush()

    response = await client.get(BASE_URL)
    assert response.status_code == 200

    stats = response.json()["board_stats"]
    assert len(stats) == 1
    assert stats[0]["board_id"] == str(board.id)
    assert stats[0]["name"] == "Delivery"
    assert stats[0]["card_count"] == 6
    assert stats[0]["distribution"] == {
        "backlog": 2,
        "active": 1,
        "review": 0,
        "done": 3,
        "blocked": 0,
        "untyped": 0,
    }


async def test_summary_counts_cards_in_untyped_columns(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    board = _board(test_workspace, test_user, "Scratch")
    db_session.add(board)
    await db_session.flush()

    untyped = _column(board, "Ideas", None)
    db_session.add(untyped)
    await db_session.flush()

    db_session.add_all(
        [_card(board, untyped, test_user, "i1"), _card(board, untyped, test_user, "i2")]
    )
    await db_session.flush()

    response = await client.get(BASE_URL)

    stats = response.json()["board_stats"][0]
    assert stats["distribution"]["untyped"] == 2
    assert stats["card_count"] == 2


async def test_overdue_counts_past_due_cards_outside_done_columns(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    board = _board(test_workspace, test_user, "Deadlines")
    db_session.add(board)
    await db_session.flush()

    active = _column(board, "In Progress", ColumnType.active)
    done = _column(board, "Done", ColumnType.done)
    db_session.add_all([active, done])
    await db_session.flush()

    # Anchor on the same clock the overdue path reads (local `date.today()`, the
    # right anchor for a user-picked calendar due date). A pinned literal here
    # silently rots into a failure the day the real date passes it.
    today = date.today()
    yesterday = today - timedelta(days=1)
    tomorrow = today + timedelta(days=1)

    db_session.add_all(
        [
            _card(board, active, test_user, "overdue", due_date=yesterday),
            _card(board, active, test_user, "also overdue", due_date=yesterday),
            _card(board, active, test_user, "not yet due", due_date=tomorrow),
            _card(board, active, test_user, "no due date"),
            # Shipped work is never overdue, however old its due date.
            _card(board, done, test_user, "shipped late", due_date=yesterday),
        ]
    )
    await db_session.flush()

    response = await client.get(BASE_URL)

    assert response.json()["board_stats"][0]["overdue_count"] == 2


async def test_card_due_today_is_not_overdue(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """The boundary: overdue means the due date has PASSED, not that it is here."""
    board = _board(test_workspace, test_user, "Boundary")
    db_session.add(board)
    await db_session.flush()

    active = _column(board, "In Progress", ColumnType.active)
    db_session.add(active)
    await db_session.flush()

    db_session.add(_card(board, active, test_user, "due today", due_date=date.today()))
    await db_session.flush()

    response = await client.get(BASE_URL)

    assert response.json()["board_stats"][0]["overdue_count"] == 0


async def test_board_stats_cover_every_board_including_empty_ones(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    populated = _board(test_workspace, test_user, "Populated")
    empty = _board(test_workspace, test_user, "Empty")
    db_session.add_all([populated, empty])
    await db_session.flush()

    column = _column(populated, "To Do", ColumnType.backlog)
    db_session.add(column)
    await db_session.flush()
    db_session.add(_card(populated, column, test_user, "only card"))
    await db_session.flush()

    response = await client.get(BASE_URL)

    stats = {entry["name"]: entry for entry in response.json()["board_stats"]}
    assert set(stats) == {"Populated", "Empty"}
    assert stats["Empty"]["card_count"] == 0
    assert stats["Empty"]["overdue_count"] == 0
    assert stats["Empty"]["distribution"] == {
        "backlog": 0,
        "active": 0,
        "review": 0,
        "done": 0,
        "blocked": 0,
        "untyped": 0,
    }


async def test_board_stats_exclude_other_workspaces(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    other_workspace = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_workspace)
    await db_session.flush()

    mine = _board(test_workspace, test_user, "Mine")
    theirs = _board(other_workspace, test_user, "Theirs")
    db_session.add_all([mine, theirs])
    await db_session.flush()

    response = await client.get(BASE_URL)

    names = [entry["name"] for entry in response.json()["board_stats"]]
    assert names == ["Mine"]


async def test_empty_workspace_reports_no_board_stats(
    client: AsyncClient,
    test_workspace: Workspace,
):
    response = await client.get(BASE_URL)

    assert response.status_code == 200
    assert response.json()["board_stats"] == []
