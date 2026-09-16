# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant, Priority
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


def _health_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/health"


async def _create_three_columns(db: AsyncSession, board: Board) -> tuple[Column, Column, Column]:
    """Create To Do / In Progress / Done columns for a board."""
    todo = Column(board_id=board.id, name="To Do", position=1024.0, color="#6b7280")
    in_progress = Column(board_id=board.id, name="In Progress", position=2048.0, color="#3b82f6")
    done = Column(board_id=board.id, name="Done", position=3072.0, color="#22c55e")
    db.add_all([todo, in_progress, done])
    await db.flush()
    return todo, in_progress, done


async def _create_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    title: str = "Card",
    description: str = "Some description",
    priority: Priority = Priority.medium,
    due_date: date | None = None,
    position: float = 1024.0,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description=description,
        priority=priority,
        due_date=due_date,
        position=position,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def test_board_health_empty_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """Board with columns but no cards should return score 100."""
    await _create_three_columns(db_session, test_board)

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert data["health_score"] == 100
    assert data["total_cards"] == 0
    assert data["stale_cards"] == []
    assert data["overdue_cards"] == []
    assert data["unassigned_cards"] == []
    assert data["cards_without_priority"] == []
    assert data["cards_without_description"] == []
    assert data["priority_distribution"] == {}
    assert data["velocity_7d"] == 0
    assert data["velocity_30d"] == 0
    # Column distribution should show all columns with 0
    assert data["column_distribution"] == {"To Do": 0, "In Progress": 0, "Done": 0}


async def test_board_health_with_cards(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Create cards with varying attributes and verify distributions and score components."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    # Card 1: has priority, description, hero assignee (in To Do)
    card1 = await _create_card(
        db_session, test_board, todo, test_user,
        title="Good Card", description="Well described", priority=Priority.high,
    )
    participant = CardParticipant(card_id=card1.id, user_id=test_user.id, role="hero")
    db_session.add(participant)
    await db_session.flush()

    # Card 2: no priority, no description, no hero (in In Progress)
    await _create_card(
        db_session, test_board, in_progress, test_user,
        title="Bare Card", description="", priority=Priority.none,
    )

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert data["total_cards"] == 2
    assert len(data["unassigned_cards"]) == 1
    assert data["unassigned_cards"][0]["title"] == "Bare Card"
    assert len(data["cards_without_priority"]) == 1
    assert data["cards_without_priority"][0]["title"] == "Bare Card"
    assert len(data["cards_without_description"]) == 1
    assert data["cards_without_description"][0]["title"] == "Bare Card"

    # Score: priority 20*(1/2)=10, hero 20*(1/2)=10, desc 15*(1/2)=7.5,
    # overdue 0/2 => 15, stale: 1 card in progress with no activity (1/2=50% > 15%) => 0,
    # balance: To Do=1, In Progress=1 => max=1 which is 50% of 2 => NOT >50% => 15
    # Total: 10+10+7.5+15+0+15 = 57.5 => 58
    assert data["health_score"] == 58


async def test_board_health_overdue_cards(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Cards with past due_date appear in overdue_cards."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    yesterday = date.today() - timedelta(days=3)
    overdue_card = await _create_card(
        db_session, test_board, todo, test_user,
        title="Overdue Task", due_date=yesterday, priority=Priority.high,
        description="Has a description",
    )
    # Add hero so it doesn't affect other metrics
    db_session.add(CardParticipant(card_id=overdue_card.id, user_id=test_user.id, role="hero"))
    await db_session.flush()

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["overdue_cards"]) == 1
    overdue = data["overdue_cards"][0]
    assert overdue["title"] == "Overdue Task"
    assert overdue["days_overdue"] == 3
    assert overdue["due_date"] == yesterday.isoformat()


async def test_board_health_priority_distribution(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Verify priority distribution counts."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    await _create_card(db_session, test_board, todo, test_user, title="C1", priority=Priority.high, position=1024.0)
    await _create_card(db_session, test_board, todo, test_user, title="C2", priority=Priority.high, position=2048.0)
    await _create_card(db_session, test_board, todo, test_user, title="C3", priority=Priority.low, position=3072.0)
    await _create_card(db_session, test_board, in_progress, test_user, title="C4", priority=Priority.none, position=1024.0)
    await _create_card(db_session, test_board, done, test_user, title="C5", priority=Priority.urgent, position=1024.0)

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    dist = data["priority_distribution"]
    assert dist["high"] == 2
    assert dist["low"] == 1
    assert dist["none"] == 1
    assert dist["urgent"] == 1
    assert data["total_cards"] == 5

    # Column distribution
    assert data["column_distribution"]["To Do"] == 3
    assert data["column_distribution"]["In Progress"] == 1
    assert data["column_distribution"]["Done"] == 1


async def test_board_health_nonexistent_board(
    client: AsyncClient,
    test_workspace: Workspace,
):
    """Nonexistent board returns 404."""
    fake_id = uuid.uuid4()
    response = await client.get(_health_url(fake_id))
    assert response.status_code == 404


def _escalate_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/health/escalate"


async def test_escalate_stale_cards_no_stale(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Escalation with no stale cards returns empty list."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    # Card in To Do (not in progress) -- won't be stale
    await _create_card(
        db_session, test_board, todo, test_user,
        title="Safe Card", priority=Priority.medium,
    )

    response = await client.post(_escalate_url(test_board.id))
    assert response.status_code == 200
    data = response.json()
    assert data["escalated"] == []


async def test_escalate_stale_cards_moves_to_todo(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Stale card in In Progress gets moved back to To Do."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    # Card in In Progress with no activity -- will be stale
    stale_card = await _create_card(
        db_session, test_board, in_progress, test_user,
        title="Stale Card", priority=Priority.medium,
    )

    response = await client.post(_escalate_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["escalated"]) == 1
    entry = data["escalated"][0]
    assert entry["card_id"] == str(stale_card.id)
    assert entry["title"] == "Stale Card"
    assert "moved_to_todo" in entry["actions"]

    # Verify card actually moved
    await db_session.refresh(stale_card)
    assert stale_card.column_id == todo.id


async def test_escalate_stale_cards_unassigns_hero(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Stale card with a hero gets hero removed and moved to To Do."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    stale_card = await _create_card(
        db_session, test_board, in_progress, test_user,
        title="Hero Card", priority=Priority.high,
    )
    db_session.add(CardParticipant(card_id=stale_card.id, user_id=test_user.id, role="hero"))
    await db_session.flush()

    response = await client.post(_escalate_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["escalated"]) == 1
    entry = data["escalated"][0]
    assert "unassigned_hero" in entry["actions"]
    assert "moved_to_todo" in entry["actions"]


async def test_escalate_stale_cards_nonexistent_board(
    client: AsyncClient,
    test_workspace: Workspace,
):
    """Escalation on nonexistent board returns 404."""
    fake_id = uuid.uuid4()
    response = await client.post(_escalate_url(fake_id))
    assert response.status_code == 404


# --- SWE-AF #2 surfacing: parked (needs-advisor) cards in board health ---
#
# The stuck-loop detector (app/services/reviews/stuck_loop.py) parks a card by
# appending the `needs-advisor` label; the scheduler then skips it for
# reviewer/coder. Today parking is invisible to humans. Board health is the
# pull-side surface: it must list parked cards so an operator can find and
# unpark them (removing the label fully re-queues the card).


async def test_board_health_parked_cards_lists_needs_advisor_card(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """A card carrying the `needs-advisor` label appears in parked_cards."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    parked = await _create_card(
        db_session, test_board, todo, test_user,
        title="Stuck In Review Loop", priority=Priority.high,
    )
    parked.labels = ["needs-advisor"]
    ordinary = await _create_card(
        db_session, test_board, todo, test_user,
        title="Ordinary Card", priority=Priority.medium,
    )
    await db_session.flush()

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert "parked_cards" in data, "health payload must expose parked_cards"
    assert len(data["parked_cards"]) == 1
    entry = data["parked_cards"][0]
    assert entry["id"] == str(parked.id)
    assert entry["title"] == "Stuck In Review Loop"
    # Brief-card shape mirrors CardBriefInfo: the operator needs to know WHERE
    # the parked card sits to go unpark it.
    assert entry["column_name"] == "To Do"
    assert str(ordinary.id) not in [c["id"] for c in data["parked_cards"]]


async def test_board_health_parked_cards_empty_when_no_parked(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """No needs-advisor labels on the board -> parked_cards is an empty list."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)
    await _create_card(
        db_session, test_board, todo, test_user,
        title="Plain Card", priority=Priority.medium,
    )

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert "parked_cards" in data, "health payload must expose parked_cards"
    assert data["parked_cards"] == []


async def test_board_health_parked_cards_empty_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    db_session: AsyncSession,
):
    """The zero-card early return must also carry the parked_cards field."""
    await _create_three_columns(db_session, test_board)

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert "parked_cards" in data, "health payload must expose parked_cards"
    assert data["parked_cards"] == []


async def test_board_health_parked_cards_ignores_other_labels(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Only the exact `needs-advisor` label parks; other labels never match."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    labeled = await _create_card(
        db_session, test_board, todo, test_user,
        title="Labeled But Not Parked", priority=Priority.medium,
    )
    labeled.labels = ["ui", "blocked", "needs-advisor-review"]
    await db_session.flush()

    response = await client.get(_health_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert "parked_cards" in data, "health payload must expose parked_cards"
    assert data["parked_cards"] == []


async def test_board_health_score_unchanged_by_parked_label(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Parking is a routing state, not a hygiene defect: same board with and
    without the needs-advisor label must yield the same health_score."""
    todo, in_progress, done = await _create_three_columns(db_session, test_board)

    card = await _create_card(
        db_session, test_board, todo, test_user,
        title="Score Probe", priority=Priority.high,
    )
    db_session.add(CardParticipant(card_id=card.id, user_id=test_user.id, role="hero"))
    await db_session.flush()

    before = await client.get(_health_url(test_board.id))
    assert before.status_code == 200
    score_before = before.json()["health_score"]

    card.labels = ["needs-advisor"]
    await db_session.flush()

    after = await client.get(_health_url(test_board.id))
    assert after.status_code == 200
    data = after.json()

    assert data["health_score"] == score_before, (
        "needs-advisor must not move the health score"
    )
    assert "parked_cards" in data, "health payload must expose parked_cards"
    assert [c["id"] for c in data["parked_cards"]] == [str(card.id)]
