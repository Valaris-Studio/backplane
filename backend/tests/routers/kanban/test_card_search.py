# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardParticipant, CardType, Priority
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


def _search_url(board: Board, **params) -> str:
    qs = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    return f"{BASE}/{board.id}/cards/search?{qs}" if qs else f"{BASE}/{board.id}/cards/search"


async def _make_card(
    db: AsyncSession, board: Board, column: Column, user: User, **overrides
) -> Card:
    defaults = dict(
        board_id=board.id,
        column_id=column.id,
        title="Untitled",
        description="",
        position=1024.0,
        created_by=user.id,
    )
    defaults.update(overrides)
    card = Card(**defaults)
    db.add(card)
    await db.flush()
    return card


async def test_search_cards_by_text(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(db_session, test_board, test_column, test_user, title="Login page", description="Build the login")
    await _make_card(db_session, test_board, test_column, test_user, title="Dashboard", description="Main dashboard view")
    await _make_card(db_session, test_board, test_column, test_user, title="Settings", description="User settings login fix")

    # Search by title match
    resp = await client.get(_search_url(test_board, q="login"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    titles = {c["title"] for c in data}
    assert "Login page" in titles
    assert "Settings" in titles  # matches description


async def test_search_cards_by_priority(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(db_session, test_board, test_column, test_user, title="Low card", priority=Priority.low)
    await _make_card(db_session, test_board, test_column, test_user, title="High card", priority=Priority.high)
    await _make_card(db_session, test_board, test_column, test_user, title="Another high", priority=Priority.high)

    resp = await client.get(_search_url(test_board, priority="high"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert all(c["priority"] == "high" for c in data)


async def test_search_cards_by_card_type(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(db_session, test_board, test_column, test_user, title="Bug 1", card_type=CardType.bug)
    await _make_card(db_session, test_board, test_column, test_user, title="Feature 1", card_type=CardType.feature)
    await _make_card(db_session, test_board, test_column, test_user, title="Bug 2", card_type=CardType.bug)

    resp = await client.get(_search_url(test_board, card_type="bug"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    assert all(c["card_type"] == "bug" for c in data)


async def test_search_cards_by_label(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(db_session, test_board, test_column, test_user, title="Frontend task", labels=["frontend", "urgent"])
    await _make_card(db_session, test_board, test_column, test_user, title="Backend task", labels=["backend"])
    await _make_card(db_session, test_board, test_column, test_user, title="No labels")

    resp = await client.get(_search_url(test_board, label="frontend"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Frontend task"


async def test_search_cards_label_exact_match(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Label filter must exact-match array elements, not substring the JSON text.

    Regression: searching `role:implementer` previously returned cards labeled
    `role:implementer-skip` because the filter was an ILIKE on the cast JSON.
    """
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Implementer card", labels=["role:implementer"],
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Skip card", labels=["role:implementer-skip"],
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Implementer urgent", labels=["role:implementer", "priority:high"],
    )

    resp = await client.get(_search_url(test_board, label="role:implementer"))
    assert resp.status_code == 200
    data = resp.json()
    titles = {c["title"] for c in data}
    assert titles == {"Implementer card", "Implementer urgent"}
    assert "Skip card" not in titles


async def test_search_cards_label_no_match(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="A", labels=["role:implementer"],
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="B", labels=["role:implementer-skip"],
    )

    resp = await client.get(_search_url(test_board, label="nonexistent"))
    assert resp.status_code == 200
    data = resp.json()
    assert data == []


async def test_search_cards_label_with_special_chars(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Labels with `:`, `-`, `/`, `.` must still match exactly."""
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Role card", labels=["role:implementer"],
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Branch card", labels=["feature/auth-fix"],
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Neighbor", labels=["feature/auth-fix-extended"],
    )

    resp = await client.get(_search_url(test_board, label="role:implementer"))
    assert resp.status_code == 200
    assert {c["title"] for c in resp.json()} == {"Role card"}

    resp = await client.get(_search_url(test_board, label="feature/auth-fix"))
    assert resp.status_code == 200
    assert {c["title"] for c in resp.json()} == {"Branch card"}


async def test_search_cards_overdue(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    yesterday = date.today() - timedelta(days=1)
    tomorrow = date.today() + timedelta(days=1)

    await _make_card(db_session, test_board, test_column, test_user, title="Overdue card", due_date=yesterday)
    await _make_card(db_session, test_board, test_column, test_user, title="Future card", due_date=tomorrow)
    await _make_card(db_session, test_board, test_column, test_user, title="No due date")

    resp = await client.get(_search_url(test_board, overdue="true"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Overdue card"


async def test_search_cards_no_results(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(db_session, test_board, test_column, test_user, title="Some card")

    resp = await client.get(_search_url(test_board, q="nonexistent_xyz"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 0


async def test_search_cards_combined_filters(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Critical bug", card_type=CardType.bug, priority=Priority.high,
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Minor bug", card_type=CardType.bug, priority=Priority.low,
    )
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Critical feature", card_type=CardType.feature, priority=Priority.high,
    )

    resp = await client.get(_search_url(test_board, card_type="bug", priority="high"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Critical bug"


async def test_search_cards_limit(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    for i in range(5):
        await _make_card(
            db_session, test_board, test_column, test_user,
            title=f"Card {i}", position=float(i * 1024),
        )

    resp = await client.get(_search_url(test_board, limit=2))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2


async def test_search_cards_by_column(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    second_column = Column(board_id=test_board.id, name="Done", position=2048.0)
    db_session.add(second_column)
    await db_session.flush()

    await _make_card(db_session, test_board, test_column, test_user, title="In todo")
    await _make_card(db_session, test_board, second_column, test_user, title="In done", column_id=second_column.id)

    resp = await client.get(_search_url(test_board, column_id=str(test_column.id)))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "In todo"


async def test_search_cards_by_status(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(db_session, test_board, test_column, test_user, title="Blocked card", status="blocked")
    await _make_card(db_session, test_board, test_column, test_user, title="Active card", status="active")

    resp = await client.get(_search_url(test_board, status="blocked"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Blocked card"


async def test_search_cards_by_column_type(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType

    # test_column has no column_type by default
    review_col = Column(
        board_id=test_board.id, name="Code Review", position=2048.0,
        column_type=ColumnType.review,
    )
    done_col = Column(
        board_id=test_board.id, name="Shipped!", position=3072.0,
        column_type=ColumnType.done,
    )
    db_session.add_all([review_col, done_col])
    await db_session.flush()

    await _make_card(db_session, test_board, test_column, test_user, title="Backlog card")
    await _make_card(db_session, test_board, review_col, test_user, title="Review card", column_id=review_col.id)
    await _make_card(db_session, test_board, done_col, test_user, title="Done card", column_id=done_col.id)

    # Search by column_type=review
    resp = await client.get(_search_url(test_board, column_type="review"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Review card"

    # Search by column_type=done
    resp = await client.get(_search_url(test_board, column_type="done"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Done card"


async def test_search_cards_exclude_column_type(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Exclude cards from columns of a given type (e.g., orchestrator skips done+blocked)."""
    from app.models.kanban.column import ColumnType

    active_col = Column(
        board_id=test_board.id, name="In Progress", position=2048.0,
        column_type=ColumnType.active,
    )
    done_col = Column(
        board_id=test_board.id, name="Done", position=3072.0,
        column_type=ColumnType.done,
    )
    db_session.add_all([active_col, done_col])
    await db_session.flush()

    await _make_card(db_session, test_board, test_column, test_user, title="Backlog card")
    await _make_card(db_session, test_board, active_col, test_user, title="Active card", column_id=active_col.id)
    await _make_card(db_session, test_board, done_col, test_user, title="Done card", column_id=done_col.id)

    # Exclude done columns
    resp = await client.get(_search_url(test_board, exclude_column_type="done"))
    assert resp.status_code == 200
    data = resp.json()
    titles = {c["title"] for c in data}
    assert "Backlog card" in titles
    assert "Active card" in titles
    assert "Done card" not in titles


async def test_search_cards_has_assignee(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    assigned_card = await _make_card(
        db_session, test_board, test_column, test_user, title="Assigned card",
    )
    await _make_card(db_session, test_board, test_column, test_user, title="Unassigned card")

    participant = CardParticipant(card_id=assigned_card.id, user_id=second_user.id, role="hero")
    db_session.add(participant)
    await db_session.flush()

    # has_assignee=true returns only the assigned card
    resp = await client.get(_search_url(test_board, has_assignee="true"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Assigned card"

    # has_assignee=false returns only the unassigned card
    resp = await client.get(_search_url(test_board, has_assignee="false"))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Unassigned card"


# --- Fix A.1.2: assignee_id filter ---


async def test_search_cards_assignee_id_filters_by_participant(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    """assignee_id query param returns only cards where user is a participant."""
    assigned = await _make_card(
        db_session, test_board, test_column, test_user, title="Assigned to second",
    )
    await _make_card(db_session, test_board, test_column, test_user, title="Not assigned")

    participant = CardParticipant(card_id=assigned.id, user_id=second_user.id, role="hero")
    db_session.add(participant)
    await db_session.flush()

    resp = await client.get(_search_url(test_board, assignee_id=str(second_user.id)))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Assigned to second"


async def test_search_cards_assignee_id_excludes_non_participant(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    """assignee_id of a non-participant returns no cards."""
    await _make_card(db_session, test_board, test_column, test_user, title="Some card")

    resp = await client.get(_search_url(test_board, assignee_id=str(second_user.id)))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 0


async def test_search_cards_excludes_untyped_columns_when_include_untyped_false(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType

    active_col = Column(
        board_id=test_board.id, name="Active", position=2048.0,
        column_type=ColumnType.active,
    )
    db_session.add(active_col)
    await db_session.flush()

    await _make_card(db_session, test_board, test_column, test_user, title="Untyped card")
    await _make_card(db_session, test_board, active_col, test_user, title="Active card", column_id=active_col.id)

    resp = await client.get(_search_url(test_board, include_untyped="false"))
    assert resp.status_code == 200
    titles = {c["title"] for c in resp.json()}
    assert titles == {"Active card"}


async def test_search_cards_includes_untyped_columns_by_default(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType

    active_col = Column(
        board_id=test_board.id, name="Active", position=2048.0,
        column_type=ColumnType.active,
    )
    db_session.add(active_col)
    await db_session.flush()

    await _make_card(db_session, test_board, test_column, test_user, title="Untyped card")
    await _make_card(db_session, test_board, active_col, test_user, title="Active card", column_id=active_col.id)

    resp = await client.get(_search_url(test_board))
    assert resp.status_code == 200
    titles = {c["title"] for c in resp.json()}
    assert titles == {"Untyped card", "Active card"}


async def test_search_cards_include_untyped_false_still_honors_column_type_filter(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType

    active_col = Column(
        board_id=test_board.id, name="Active", position=2048.0,
        column_type=ColumnType.active,
    )
    review_col = Column(
        board_id=test_board.id, name="Review", position=3072.0,
        column_type=ColumnType.review,
    )
    db_session.add_all([active_col, review_col])
    await db_session.flush()

    await _make_card(db_session, test_board, test_column, test_user, title="Untyped card")
    await _make_card(db_session, test_board, active_col, test_user, title="Active card", column_id=active_col.id)
    await _make_card(db_session, test_board, review_col, test_user, title="Review card", column_id=review_col.id)

    resp = await client.get(_search_url(test_board, include_untyped="false", column_type="active"))
    assert resp.status_code == 200
    titles = {c["title"] for c in resp.json()}
    assert titles == {"Active card"}


async def test_search_cards_include_untyped_false_respects_exclude_column_type(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType

    backlog_col = Column(
        board_id=test_board.id, name="Backlog", position=2048.0,
        column_type=ColumnType.backlog,
    )
    active_col = Column(
        board_id=test_board.id, name="Active", position=3072.0,
        column_type=ColumnType.active,
    )
    db_session.add_all([backlog_col, active_col])
    await db_session.flush()

    # test_column is untyped
    await _make_card(db_session, test_board, test_column, test_user, title="Untyped card")
    await _make_card(db_session, test_board, backlog_col, test_user, title="Backlog card", column_id=backlog_col.id)
    await _make_card(db_session, test_board, active_col, test_user, title="Active card", column_id=active_col.id)

    resp = await client.get(_search_url(test_board, include_untyped="false", exclude_column_type="backlog"))
    assert resp.status_code == 200
    titles = {c["title"] for c in resp.json()}
    assert titles == {"Active card"}


async def test_search_cards_assignee_id_with_agent_id(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """assignee_id also matches on CardParticipant.agent_id for agent-claimed cards."""
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(name="search-agent", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    card = await _make_card(
        db_session, test_board, test_column, test_user, title="Agent-claimed card",
    )
    await _make_card(
        db_session, test_board, test_column, test_user, title="Unclaimed card",
    )
    participant = CardParticipant(
        card_id=card.id, user_id=test_user.id, role="hero", agent_id=agent.id,
    )
    db_session.add(participant)
    await db_session.flush()

    # Search by agent_id — should find only the claimed card
    resp = await client.get(_search_url(test_board, assignee_id=str(agent.id)))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    assert data[0]["title"] == "Agent-claimed card"


async def test_search_cards_all_dependencies_done_excludes_blocked_card(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    """Defense-in-depth for the client pilot chain-race: when
    all_dependencies_done=true, /search must exclude any card whose dependency
    is still in a non-done column, so the runner's legacy /search-based discover
    fallbacks can't bypass the scheduler's dependency gate. Mirrors the
    NOT-EXISTS(unsatisfied_dep) logic in assignment_service._candidate_cards."""
    from app.models.kanban.card import CardDependency
    from app.models.kanban.column import ColumnType

    backlog = Column(
        board_id=test_board.id, name="To Do", position=1024.0,
        color="#6b7280", column_type=ColumnType.backlog,
    )
    done = Column(
        board_id=test_board.id, name="Done", position=4096.0,
        color="#10b981", column_type=ColumnType.done,
    )
    db_session.add_all([backlog, done])
    await db_session.flush()

    dependent = await _make_card(
        db_session, test_board, backlog, test_user, title="dependent", position=1.0,
    )
    open_prereq = await _make_card(
        db_session, test_board, backlog, test_user, title="open prereq", position=2.0,
    )
    db_session.add(
        CardDependency(
            card_id=dependent.id,
            depends_on_card_id=open_prereq.id,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    resp = await client.get(
        _search_url(test_board, all_dependencies_done="true")
    )
    assert resp.status_code == 200, resp.text
    titles = {c["title"] for c in resp.json()}
    assert "dependent" not in titles, "blocked card leaked past the dep filter"
    assert "open prereq" in titles, "card with no deps should remain eligible"


async def test_search_cards_all_dependencies_done_allows_when_prereq_done(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.card import CardDependency
    from app.models.kanban.column import ColumnType

    backlog = Column(
        board_id=test_board.id, name="To Do", position=1024.0,
        color="#6b7280", column_type=ColumnType.backlog,
    )
    done = Column(
        board_id=test_board.id, name="Done", position=4096.0,
        color="#10b981", column_type=ColumnType.done,
    )
    db_session.add_all([backlog, done])
    await db_session.flush()

    dependent = await _make_card(
        db_session, test_board, backlog, test_user, title="dependent",
    )
    landed_prereq = await _make_card(
        db_session, test_board, done, test_user, title="landed prereq",
    )
    db_session.add(
        CardDependency(
            card_id=dependent.id,
            depends_on_card_id=landed_prereq.id,
            created_by=test_user.id,
        )
    )
    await db_session.flush()

    resp = await client.get(
        _search_url(test_board, all_dependencies_done="true", column_type="backlog")
    )
    assert resp.status_code == 200, resp.text
    titles = {c["title"] for c in resp.json()}
    assert "dependent" in titles, "card whose prereq landed should be eligible"


async def test_search_cards_full_response_carries_column_name_and_type(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType

    backlog = Column(
        board_id=test_board.id, name="To Do", position=1024.0,
        color="#6b7280", column_type=ColumnType.backlog,
    )
    parked = Column(
        board_id=test_board.id, name="Food for Thought", position=4096.0,
        color="#f59e0b", column_type=None,
    )
    db_session.add_all([backlog, parked])
    await db_session.flush()

    await _make_card(db_session, test_board, backlog, test_user, title="queued")
    await _make_card(db_session, test_board, parked, test_user, title="parked")

    resp = await client.get(_search_url(test_board))
    assert resp.status_code == 200, resp.text
    by_title = {c["title"]: c for c in resp.json()}

    assert by_title["queued"]["column_name"] == "To Do"
    assert by_title["queued"]["column_type"] == "backlog"
    # An untyped column still names itself; only the semantic type is null.
    assert by_title["parked"]["column_name"] == "Food for Thought"
    assert by_title["parked"]["column_type"] is None


async def test_search_cards_summary_only_drops_ballast_fields(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(
        db_session,
        test_board,
        test_column,
        test_user,
        title="Compact me",
        description="x" * 5000,
        labels=["loop-2"],
        status="in_progress",
        card_type=CardType.bug,
        priority=Priority.high,
    )

    resp = await client.get(_search_url(test_board, summary_only="true"))
    assert resp.status_code == 200, resp.text
    cards = resp.json()
    assert len(cards) == 1

    card = cards[0]
    assert set(card) == {
        "id",
        "title",
        "column_id",
        "column_name",
        "column_type",
        "labels",
        "position",
        "priority",
        "status",
        "card_type",
    }
    assert card["title"] == "Compact me"
    assert card["column_name"] == "To Do"
    assert card["labels"] == ["loop-2"]
    assert card["status"] == "in_progress"
    assert card["card_type"] == "bug"
    assert card["priority"] == "high"


async def test_search_cards_summary_only_omitted_keeps_full_payload(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    await _make_card(
        db_session, test_board, test_column, test_user,
        title="Full", description="the whole body",
    )

    resp = await client.get(_search_url(test_board))
    assert resp.status_code == 200, resp.text
    card = resp.json()[0]
    # Additive change: existing callers keep every field they had.
    assert card["description"] == "the whole body"
    assert "participants" in card
    assert "dependency_status" in card


async def test_search_cards_summary_only_carries_position_for_tie_breaking(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """The documented pick rule breaks priority ties by lowest position.

    Agents are told to triage with summary_only=true; omitting position forced
    them onto the unsummarised payload (or list_cards, which overflowed an MCP
    token budget at 2.08 MB) purely to order two equal-priority cards.
    """
    # Deliberately created out of position order so a passing sort proves the
    # field travelled, not that insertion order happened to match.
    for title, position in (("third", 3072.0), ("first", 1024.0), ("second", 2048.0)):
        await _make_card(
            db_session, test_board, test_column, test_user,
            title=title, position=position, labels=["loop-5"],
            priority=Priority.high,
        )

    summary = await client.get(_search_url(test_board, summary_only="true"))
    assert summary.status_code == 200, summary.text
    summaries = {c["title"]: c for c in summary.json()}

    full = await client.get(_search_url(test_board))
    assert full.status_code == 200, full.text
    fulls = {c["title"]: c for c in full.json()}

    assert len(summaries) == 3
    for title, card in summaries.items():
        assert card["position"] == fulls[title]["position"]

    ordered = sorted(summaries.values(), key=lambda c: c["position"])
    assert [c["title"] for c in ordered] == ["first", "second", "third"]


async def test_search_cards_column_labels_are_batched_not_n_plus_one(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    db_session: AsyncSession,
):
    from app.models.kanban.column import ColumnType
    from app.services.kanban.card import attach_column_labels

    columns = []
    for i in range(4):
        column = Column(
            board_id=test_board.id, name=f"Col {i}", position=1024.0 * (i + 1),
            color="#6b7280", column_type=ColumnType.backlog,
        )
        db_session.add(column)
        columns.append(column)
    await db_session.flush()

    cards = []
    for i, column in enumerate(columns):
        for j in range(3):
            cards.append(
                await _make_card(
                    db_session, test_board, column, test_user, title=f"c{i}-{j}"
                )
            )

    executed: list[str] = []
    original_execute = db_session.execute

    async def counting_execute(statement, *args, **kwargs):
        executed.append(str(statement))
        return await original_execute(statement, *args, **kwargs)

    db_session.execute = counting_execute
    try:
        await attach_column_labels(db_session, cards)
    finally:
        db_session.execute = original_execute

    assert len(executed) == 1, f"expected one batched column query, got {len(executed)}"
    assert {c.column_name for c in cards} == {"Col 0", "Col 1", "Col 2", "Col 3"}
