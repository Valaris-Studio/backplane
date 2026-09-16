# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError, ValidationError
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardType, Priority
from app.models.kanban.column import Column
from app.models.user import User
from app.schemas.kanban.card import CardCreate, CardMoveRequest, CardUpdate
from app.services.kanban.card import (
    CardService,
    MERGE_GATE_UNSUPPORTED_FORGE_LABEL,
)
from app.services.kanban.column import ColumnService


async def test_create_card(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    data = CardCreate(
        title="Implement login",
        description="OAuth2 flow",
        column_id=test_column.id,
    )

    card = await service.create_card(test_board.id, data, test_user.id)

    assert card.title == "Implement login"
    # Descriptions normalize to canonical PM JSON on write (editor P0-3).
    description_doc = json.loads(card.description)
    assert description_doc["type"] == "doc"
    assert description_doc["content"][0]["content"][0]["text"] == "OAuth2 flow"
    assert card.column_id == test_column.id
    assert card.board_id == test_board.id
    assert card.created_by == test_user.id
    assert card.card_type == CardType.task
    assert card.priority == Priority.none


async def test_create_card_auto_positions(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    card1 = await service.create_card(
        test_board.id,
        CardCreate(title="First", column_id=test_column.id),
        test_user.id,
    )
    card2 = await service.create_card(
        test_board.id,
        CardCreate(title="Second", column_id=test_column.id),
        test_user.id,
    )

    assert card2.position > card1.position


async def test_create_card_wrong_column(
    db_session: AsyncSession, test_board: Board, test_user: User
):
    service = CardService(db_session)
    data = CardCreate(title="Bad", column_id=uuid.uuid4())

    with pytest.raises(ResourceNotFoundError):
        await service.create_card(test_board.id, data, test_user.id)


async def test_create_card_column_from_different_board(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace,
):
    """Column exists but belongs to a different board."""
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()

    service = CardService(db_session)
    data = CardCreate(title="Cross-board", column_id=test_column.id)

    with pytest.raises(ResourceNotFoundError):
        await service.create_card(other_board.id, data, test_user.id)


async def test_get_card(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    service = CardService(db_session)

    card = await service.get_card(test_card.id, test_board.id)

    assert card.id == test_card.id
    assert card.title == test_card.title


async def test_get_card_not_found(db_session: AsyncSession, test_board: Board):
    service = CardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_card(uuid.uuid4(), test_board.id)


async def test_get_card_wrong_board(
    db_session: AsyncSession, test_card: Card
):
    service = CardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.get_card(test_card.id, uuid.uuid4())


async def test_update_card(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    service = CardService(db_session)
    data = CardUpdate(title="Updated Title", priority=Priority.high)

    updated = await service.update_card(test_card.id, test_board.id, data)

    assert updated.title == "Updated Title"
    assert updated.priority == Priority.high


async def test_update_card_partial(
    db_session: AsyncSession, test_board: Board, test_card: Card
):
    service = CardService(db_session)
    original_title = test_card.title
    data = CardUpdate(description="New desc")

    updated = await service.update_card(test_card.id, test_board.id, data)

    description_doc = json.loads(updated.description)
    assert description_doc["content"][0]["content"][0]["text"] == "New desc"
    assert updated.title == original_title


async def test_update_card_not_found(db_session: AsyncSession, test_board: Board):
    service = CardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_card(
            uuid.uuid4(), test_board.id, CardUpdate(title="X")
        )


async def test_update_card_wrong_board(
    db_session: AsyncSession, test_card: Card
):
    service = CardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.update_card(
            test_card.id, uuid.uuid4(), CardUpdate(title="X")
        )


async def test_delete_card(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    card = await service.create_card(
        test_board.id,
        CardCreate(title="Delete Me", column_id=test_column.id),
        test_user.id,
    )

    await service.delete_card(card.id, test_board.id)

    with pytest.raises(ResourceNotFoundError):
        await service.get_card(card.id, test_board.id)


async def test_delete_card_not_found(db_session: AsyncSession, test_board: Board):
    service = CardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_card(uuid.uuid4(), test_board.id)


async def test_delete_card_wrong_board(
    db_session: AsyncSession, test_card: Card
):
    service = CardService(db_session)

    with pytest.raises(ResourceNotFoundError):
        await service.delete_card(test_card.id, uuid.uuid4())


async def test_move_card_to_another_column(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    column_service = ColumnService(db_session)
    from app.schemas.kanban.column import ColumnCreate

    target = await column_service.create_column(
        test_board.id, ColumnCreate(name="Done")
    )

    service = CardService(db_session)
    data = CardMoveRequest(column_id=target.id, position=512.0)

    moved = await service.move_card(test_card.id, test_board.id, data)

    assert moved.column_id == target.id
    assert moved.position == 512.0


async def test_move_card_not_found(
    db_session: AsyncSession, test_board: Board, test_column: Column
):
    service = CardService(db_session)
    data = CardMoveRequest(column_id=test_column.id, position=100.0)

    with pytest.raises(ResourceNotFoundError):
        await service.move_card(uuid.uuid4(), test_board.id, data)


async def test_move_card_wrong_board(
    db_session: AsyncSession, test_card: Card, test_column: Column
):
    service = CardService(db_session)
    data = CardMoveRequest(column_id=test_column.id, position=100.0)

    with pytest.raises(ResourceNotFoundError):
        await service.move_card(test_card.id, uuid.uuid4(), data)


async def test_move_card_target_column_wrong_board(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    test_workspace,
):
    """Target column belongs to a different board."""
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other Board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()

    other_col = Column(board_id=other_board.id, name="Other Col", position=1024.0)
    db_session.add(other_col)
    await db_session.flush()

    service = CardService(db_session)
    data = CardMoveRequest(column_id=other_col.id, position=100.0)

    with pytest.raises(ResourceNotFoundError):
        await service.move_card(test_card.id, test_board.id, data)


# --- Tests for expanded card fields: due_date, status, labels ---


async def test_create_card_with_new_fields(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    import datetime

    service = CardService(db_session)
    data = CardCreate(
        title="Card with all new fields",
        column_id=test_column.id,
        due_date=datetime.date(2025, 12, 31),
        status="in_progress",
        labels=["frontend", "urgent"],
    )

    card = await service.create_card(test_board.id, data, test_user.id)

    assert card.title == "Card with all new fields"
    assert card.due_date == datetime.date(2025, 12, 31)
    assert card.status == "in_progress"
    assert card.labels == ["frontend", "urgent"]


async def test_update_card_new_fields(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
):
    import datetime

    service = CardService(db_session)

    # Set all new fields
    data = CardUpdate(
        due_date=datetime.date(2025, 12, 31),
        status="done",
        labels=["backend", "critical"],
    )
    updated = await service.update_card(test_card.id, test_board.id, data)

    assert updated.due_date == datetime.date(2025, 12, 31)
    assert updated.status == "done"
    assert updated.labels == ["backend", "critical"]
    assert updated.title == test_card.title  # unchanged


async def test_create_card_new_fields_default_to_none(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    service = CardService(db_session)
    data = CardCreate(
        title="Card without new fields",
        column_id=test_column.id,
    )

    card = await service.create_card(test_board.id, data, test_user.id)

    assert card.due_date is None
    assert card.status is None
    assert card.labels is None


async def test_update_card_clear_new_fields(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    import datetime

    service = CardService(db_session)
    # First create a card with all fields set
    create_data = CardCreate(
        title="Full card",
        column_id=test_column.id,
        due_date=datetime.date(2025, 12, 31),
        status="in_progress",
        labels=["frontend"],
    )
    card = await service.create_card(test_board.id, create_data, test_user.id)

    # Clear the fields
    update_data = CardUpdate(
        due_date=None,
        status=None,
        labels=None,
    )
    updated = await service.update_card(card.id, test_board.id, update_data)

    assert updated.due_date is None
    assert updated.status is None
    assert updated.labels is None


# --- Tests for card participants ---


async def test_add_participant(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    service = CardService(db_session)
    card = await service.add_participant(test_card.id, test_board.id, second_user.id, "hero")
    assert len(card.participants) == 1
    assert card.participants[0].user_id == second_user.id
    assert card.participants[0].role == "hero"


async def test_add_multiple_participants(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    service = CardService(db_session)
    await service.add_participant(test_card.id, test_board.id, second_user.id, "hero")
    card = await service.add_participant(test_card.id, test_board.id, test_user.id, "viewer")
    assert len(card.participants) == 2


async def test_add_duplicate_participant_idempotent(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Idempotent: adding the same user again returns the existing card, keeps original role."""
    service = CardService(db_session)
    await service.add_participant(test_card.id, test_board.id, second_user.id, "viewer")
    card = await service.add_participant(test_card.id, test_board.id, second_user.id, "helper")
    assert len(card.participants) == 1
    assert card.participants[0].role == "viewer"  # keeps original role


async def test_add_second_hero_rejected(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    from app.exceptions import ConflictError

    service = CardService(db_session)
    await service.add_participant(test_card.id, test_board.id, second_user.id, "hero")
    with pytest.raises(ConflictError):
        await service.add_participant(test_card.id, test_board.id, test_user.id, "hero")


async def test_add_participant_card_not_found(
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    service = CardService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.add_participant(uuid.uuid4(), test_board.id, test_user.id, "viewer")


async def test_remove_participant(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    service = CardService(db_session)
    await service.add_participant(test_card.id, test_board.id, second_user.id, "viewer")
    card = await service.remove_participant(test_card.id, test_board.id, second_user.id)
    assert len(card.participants) == 0


async def test_remove_participant_not_found(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    service = CardService(db_session)
    result = await service.remove_participant(test_card.id, test_board.id, test_user.id)
    assert result is None


async def test_remove_participant_card_not_found(
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    service = CardService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.remove_participant(uuid.uuid4(), test_board.id, test_user.id)


# --- Tests for removing participants by pipeline_role ---
#
# Multi-agent deployments run each pipeline stage as a distinct user. Clearing
# a stale stage (e.g. the `implementer` hero on rework) must target the
# pipeline_role, not the user_id the mediator happens to know.


async def test_remove_participants_by_pipeline_role_removes_match(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    """Removing by a pipeline_role drops exactly the matching participant, keeps others."""
    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="implementer",
    )
    await service.add_participant(
        test_card.id, test_board.id, test_user.id, "viewer",
        pipeline_role="reviewer",
    )

    card = await service.remove_participants_by_pipeline_role(
        test_card.id, test_board.id, "implementer",
    )

    assert len(card.participants) == 1
    assert card.participants[0].user_id == test_user.id
    assert card.participants[0].pipeline_role == "reviewer"


async def test_remove_participants_by_pipeline_role_no_match_is_idempotent(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """No participant matches the pipeline_role -> success (None), no error."""
    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="reviewer",
    )

    result = await service.remove_participants_by_pipeline_role(
        test_card.id, test_board.id, "implementer",
    )

    assert result is None
    card = await service.get_card(test_card.id, test_board.id)
    assert len(card.participants) == 1


async def test_remove_participants_by_pipeline_role_removes_all_matches(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    """Multiple participants sharing a pipeline_role are all removed."""
    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "helper",
        pipeline_role="implementer",
    )
    await service.add_participant(
        test_card.id, test_board.id, test_user.id, "helper",
        pipeline_role="implementer",
    )

    card = await service.remove_participants_by_pipeline_role(
        test_card.id, test_board.id, "implementer",
    )

    assert len(card.participants) == 0


async def test_remove_participants_by_pipeline_role_card_not_found(
    db_session: AsyncSession,
    test_board: Board,
):
    service = CardService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.remove_participants_by_pipeline_role(
            uuid.uuid4(), test_board.id, "implementer",
        )


async def test_remove_participants_by_pipeline_role_records_activity_on_removal(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
    test_user: User,
    test_workspace,
):
    """An actual removal records one activity; a no-op match records none."""
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="implementer",
    )

    await service.remove_participants_by_pipeline_role(
        test_card.id, test_board.id, "implementer",
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    activities = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )).scalars().all()
    removal_summaries = [a for a in activities if "implementer" in a.summary]
    assert len(removal_summaries) == 1

    # A second call matches nothing -> no new activity.
    await service.remove_participants_by_pipeline_role(
        test_card.id, test_board.id, "implementer",
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    activities_after = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )).scalars().all()
    removal_summaries_after = [a for a in activities_after if "implementer" in a.summary]
    assert len(removal_summaries_after) == 1


# --- Tests for enriched activity summaries ---


async def test_move_card_enriched_summary(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    test_workspace,
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    second_column = Column(board_id=test_board.id, name="In Progress", position=2048.0, color="#3b82f6")
    db_session.add(second_column)
    await db_session.flush()

    service = CardService(db_session)
    data = CardMoveRequest(column_id=second_column.id, position=512.0)

    await service.move_card(
        test_card.id, test_board.id, data,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.moved)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.card
    assert "To Do" in a.summary
    assert "In Progress" in a.summary
    assert a.changes["from_column"] == "To Do"
    assert a.changes["to_column"] == "In Progress"
    assert a.changes["column_id"]["old"] == str(test_column.id)
    assert a.changes["column_id"]["new"] == str(second_column.id)


async def test_update_card_enriched_summary(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
    test_workspace,
):
    from app.models.activity import Activity, ActivityAction, ActivityEntityType
    from sqlalchemy import select

    service = CardService(db_session)
    data = CardUpdate(title="New Title", priority=Priority.high)

    await service.update_card(
        test_card.id, test_board.id, data,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )

    result = await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.updated)
    )
    activities = list(result.scalars().all())
    assert len(activities) == 1
    a = activities[0]
    assert a.entity_type == ActivityEntityType.card
    assert "title" in a.summary
    assert "priority" in a.summary
    assert set(a.changes["fields"]) == {"title", "priority"}


# --- Fix A.1.1: add_participant agent_id → user resolution ---


async def test_add_participant_with_agent_id_resolves_owner(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Passing agent_id resolves the agent's owner as user_id for the participant."""
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(name="resolver-agent", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    service = CardService(db_session)
    card = await service.add_participant(
        test_card.id, test_board.id,
        user_id=test_user.id,  # will be overridden by agent resolution
        role="hero",
        agent_id=agent.id,
    )
    assert len(card.participants) == 1
    assert card.participants[0].user_id == test_user.id
    assert card.participants[0].agent_id == agent.id


async def test_add_participant_with_agent_id_idempotent(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Passing the same agent_id twice returns existing participant — no 409."""
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(name="idem-agent", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    service = CardService(db_session)
    card1 = await service.add_participant(
        test_card.id, test_board.id,
        user_id=test_user.id, role="hero", agent_id=agent.id,
    )
    card2 = await service.add_participant(
        test_card.id, test_board.id,
        user_id=test_user.id, role="viewer", agent_id=agent.id,
    )
    assert len(card2.participants) == 1
    assert card2.participants[0].role == "hero"  # keeps original role


async def test_add_participant_with_invalid_agent_id_404(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Passing a nonexistent agent_id returns 404."""
    service = CardService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.add_participant(
            test_card.id, test_board.id,
            user_id=test_user.id, role="viewer",
            agent_id=uuid.uuid4(),
        )


# --- F-14 follow-up: pipeline_role plumbing on add_participant ---


async def test_add_participant_persists_pipeline_role(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """When pipeline_role is provided, the new participant row stores it."""
    service = CardService(db_session)
    card = await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="implementer",
    )
    assert len(card.participants) == 1
    assert card.participants[0].pipeline_role == "implementer"


async def test_add_participant_pipeline_role_defaults_to_none(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Back-compat: omitting pipeline_role leaves the column NULL."""
    service = CardService(db_session)
    card = await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
    )
    assert card.participants[0].pipeline_role is None


async def test_add_participant_idempotent_backfills_null_pipeline_role(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Idempotency extension: existing NULL pipeline_role is filled in on retry.

    Legacy rows predate the column. A subsequent claim from the runner with a
    non-empty pipeline_role should backfill the field on the existing row so
    role-aware filters start working without an explicit migration backfill.
    """
    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
    )
    card = await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="reviewer",
    )
    assert card.participants[0].pipeline_role == "reviewer"


async def test_add_participant_idempotent_keeps_existing_pipeline_role(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """A second call with a different non-NULL pipeline_role keeps the first.

    Overwriting silently would hide a routing bug. Keep the original; the
    service logs a WARN so an operator can find the call site.
    """
    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="reviewer",
    )
    card = await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="documentator",
    )
    assert card.participants[0].pipeline_role == "reviewer"


async def test_add_participant_idempotent_same_pipeline_role_noop(
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Repeating the same pipeline_role is a no-op, returns the existing row."""
    service = CardService(db_session)
    await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="reviewer",
    )
    card = await service.add_participant(
        test_card.id, test_board.id, second_user.id, "hero",
        pipeline_role="reviewer",
    )
    assert len(card.participants) == 1
    assert card.participants[0].pipeline_role == "reviewer"


# --- Fix A.1.2: assignee_id filter in search_cards ---


async def test_search_cards_assignee_id_filters_by_participant(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
    test_workspace,
):
    """search_cards with assignee_id returns only cards where user is a participant."""
    service = CardService(db_session)
    data = CardCreate(title="Assigned Card", column_id=test_column.id)
    card = await service.create_card(test_board.id, data, test_user.id, workspace_id=test_workspace.id)
    await service.add_participant(card.id, test_board.id, second_user.id, "hero")

    # Also create an unrelated card
    data2 = CardCreate(title="Unassigned Card", column_id=test_column.id)
    await service.create_card(test_board.id, data2, test_user.id, workspace_id=test_workspace.id)

    results = await service.search_cards(
        test_board.id, test_workspace.id, assignee_id=second_user.id,
    )
    assert len(results) == 1
    assert results[0].title == "Assigned Card"


async def test_search_cards_assignee_id_excludes_non_participant(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    second_user: User,
    test_workspace,
):
    """search_cards with assignee_id of a non-participant returns no cards."""
    service = CardService(db_session)
    data = CardCreate(title="Some Card", column_id=test_column.id)
    await service.create_card(test_board.id, data, test_user.id, workspace_id=test_workspace.id)

    results = await service.search_cards(
        test_board.id, test_workspace.id, assignee_id=second_user.id,
    )
    assert len(results) == 0


async def test_search_cards_include_untyped_false_excludes_null_column_type(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_workspace,
):
    from app.models.kanban.column import ColumnType

    active_col = Column(
        board_id=test_board.id, name="Active", position=2048.0,
        column_type=ColumnType.active,
    )
    db_session.add(active_col)
    await db_session.flush()

    service = CardService(db_session)
    await service.create_card(
        test_board.id,
        CardCreate(title="Untyped card", column_id=test_column.id),
        test_user.id, workspace_id=test_workspace.id,
    )
    await service.create_card(
        test_board.id,
        CardCreate(title="Active card", column_id=active_col.id),
        test_user.id, workspace_id=test_workspace.id,
    )

    results = await service.search_cards(
        test_board.id, test_workspace.id, include_untyped=False,
    )
    titles = {c.title for c in results}
    assert titles == {"Active card"}


# --- Fix A.2.1: Short-circuit no-op card moves ---


async def test_move_card_noop_same_column_same_position(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    test_workspace,
):
    """Moving a card to the same column and same position is a no-op — no activity recorded."""
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    service = CardService(db_session)
    data = CardMoveRequest(column_id=test_column.id, position=test_card.position)
    result = await service.move_card(
        test_card.id, test_board.id, data,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    assert result.id == test_card.id

    activities = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.moved)
    )).scalars().all()
    assert len(list(activities)) == 0


async def test_move_card_same_column_different_position(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    test_workspace,
):
    """Moving a card within the same column but different position is NOT a no-op."""
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    service = CardService(db_session)
    new_position = test_card.position + 512.0
    data = CardMoveRequest(column_id=test_column.id, position=new_position)
    result = await service.move_card(
        test_card.id, test_board.id, data,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    assert result.position == new_position

    activities = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.moved)
    )).scalars().all()
    assert len(list(activities)) == 1


async def test_move_card_different_column_records_activity(
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
    test_workspace,
):
    """Moving a card to a different column always records activity."""
    from app.models.activity import Activity, ActivityAction
    from sqlalchemy import select

    second_column = Column(board_id=test_board.id, name="Done", position=2048.0, color="#10b981")
    db_session.add(second_column)
    await db_session.flush()

    service = CardService(db_session)
    data = CardMoveRequest(column_id=second_column.id, position=test_card.position)
    result = await service.move_card(
        test_card.id, test_board.id, data,
        workspace_id=test_workspace.id, actor_id=test_user.id,
    )
    assert result.column_id == second_column.id

    activities = (await db_session.execute(
        select(Activity).where(Activity.action == ActivityAction.moved)
    )).scalars().all()
    assert len(list(activities)) == 1


# --- Phase 2: Backend-owned merge gate on move_card ---


import pytest_asyncio  # noqa: E402


@pytest_asyncio.fixture
async def gate_board_cols(db_session: AsyncSession, test_board: Board):
    """Board with columns of every type relevant to gate logic."""
    from app.models.kanban.column import ColumnType

    backlog = Column(
        board_id=test_board.id, name="Backlog", position=1024.0,
        column_type=ColumnType.backlog,
    )
    review = Column(
        board_id=test_board.id, name="Review", position=2048.0,
        column_type=ColumnType.review,
    )
    done = Column(
        board_id=test_board.id, name="Done", position=3072.0,
        column_type=ColumnType.done,
    )
    done2 = Column(
        board_id=test_board.id, name="Shipped", position=4096.0,
        column_type=ColumnType.done,
    )
    untyped = Column(
        board_id=test_board.id, name="Untyped", position=5120.0,
    )
    db_session.add_all([backlog, review, done, done2, untyped])
    await db_session.flush()
    return {
        "backlog": backlog, "review": review,
        "done": done, "done2": done2, "untyped": untyped,
    }


_PR_DESC = (
    "Implement feature.\n\n---\nBranch: feat/x\n"
    "PR: https://github.com/acme/widget/pull/9\n"
)


@pytest_asyncio.fixture
async def gate_board_repo(db_session: AsyncSession, test_board: Board, test_user: User):
    """Link a git repo to the gate board, with a credential that can read it.

    The done-merge gate only applies to boards that can actually produce a
    mergeable PR, so every test that exercises the gate itself needs this.

    The bound connection matters as much as the repo: PR-merge verification
    resolves the repo's credential and defers verification when there is none
    (a workspace whose forge the platform cannot see must not have its cards
    wedged). Tests that assert the gate's VERDICT therefore have to give it a
    credential to reach the verdict with — the no-credential path has its own
    tests in tests/services/git/test_consumer_credential_resolution.py.
    """
    import os

    from app.integrations.git.vault import FernetTokenVault
    from app.models.git.git_connection import GitConnection
    from app.models.git.git_repo import GitProvider, GitRepo

    vault = FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())
    connection = GitConnection(
        workspace_id=test_board.workspace_id,
        provider=GitProvider.github,
        account_login="gate-bot",
        account_type="user",
        encrypted_access_token=vault.encrypt("ghp_gate"),
        scopes=["repo"],
        connected_by=test_user.id,
    )
    db_session.add(connection)
    await db_session.flush()

    repo = GitRepo(
        board_id=test_board.id,
        workspace_id=test_board.workspace_id,
        name="widget",
        slug="widget",
        url="https://github.com/acme/widget",
        provider=GitProvider.github,
        default_branch="main",
        added_by=test_user.id,
        connection_id=connection.id,
    )
    db_session.add(repo)
    await db_session.flush()
    return repo


async def _make_gate_card(
    db_session: AsyncSession, board: Board, column: Column, user: User,
    *, description: str = _PR_DESC,
) -> Card:
    card = Card(
        board_id=board.id, column_id=column.id,
        title="Gate Card", description=description,
        position=1024.0, created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()
    return card


async def test_move_card_to_done_rejects_when_pr_not_merged(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """Done-merge gate fires when an agent caller has an unmerged PR."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.exceptions import ConflictError
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=False, mergeable=True, state="open"),
        ):
            with pytest.raises(ConflictError) as exc_info:
                await service.move_card(card.id, test_board.id, data)
        assert exc_info.value.error_code == "pr_not_merged"
    finally:
        current_agent_id.reset(token)

    await db_session.refresh(card)
    assert card.column_id == gate_board_cols["review"].id


async def test_move_card_to_done_accepts_when_pr_merged(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=True, mergeable=True, state="closed"),
        ) as mock_status:
            moved = await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    mock_status.assert_called_once()
    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_to_done_rejects_when_pr_url_missing(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """Gate also fires for an agent caller when no PR URL is present at all."""
    from app.core.auth import current_agent_id

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with pytest.raises(ValidationError) as exc_info:
            await service.move_card(card.id, test_board.id, data)
        assert exc_info.value.error_code == "pr_url_missing"
    finally:
        current_agent_id.reset(token)

    await db_session.refresh(card)
    assert card.column_id == gate_board_cols["review"].id


# --- Board-awareness: a board with no linked git repo cannot produce a PR ---
#
# The workspace-wide opt-out was too coarse: ops/triage/doc boards live in the
# same workspace as code boards, and their cards never produce a PR — so an
# agent (a board loop iteration included) could never satisfy the gate and
# dead-ended. Repo linkage is the structural signal: no repo, no mergeable PR.


async def test_move_card_to_done_skips_gate_when_board_has_no_git_repo(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace,
):
    """Agent move on a repo-less board succeeds with neither PR URL nor verdict."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_to_done_enforces_gate_when_board_has_git_repo(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """The exemption is repo-scoped: a linked repo keeps the PR-URL requirement."""
    from app.core.auth import current_agent_id

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with pytest.raises(ValidationError) as exc_info:
            await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
        assert exc_info.value.error_code == "pr_url_missing"
    finally:
        current_agent_id.reset(token)

    await db_session.refresh(card)
    assert card.column_id == gate_board_cols["review"].id


async def test_move_card_to_done_with_repo_still_requires_reviewer_verdict(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """A linked repo keeps the full gate, self-merge backstop included."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.exceptions import ConflictError
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=True, mergeable=True, state="closed"),
        ):
            with pytest.raises(ConflictError) as exc_info:
                await service.move_card(
                    card.id, test_board.id, data, workspace_id=test_workspace.id,
                )
        assert exc_info.value.error_code == "merge_requires_review"
    finally:
        current_agent_id.reset(token)


async def test_move_card_to_done_workspace_opt_out_wins_over_linked_repo(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """The workspace opt-out short-circuits before the repo lookup."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.models.workspace_config import WorkspaceConfig

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id, enforce_done_merge_gate=False,
        )
    )
    await db_session.flush()

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_to_done_human_unaffected_by_board_repo_linkage(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """Humans bypass the gate on repo-linked boards exactly as before."""
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(
            card.id, test_board.id, data, workspace_id=test_workspace.id,
        )
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_to_done_skips_gate_for_human_actor_with_no_pr(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
):
    """A human (no agent context) can move to Done without any PR association.

    The Done-merge gate exists to stop autonomous runners from prematurely
    declaring work complete. Humans on the web UI / MCP often move cards that
    never had a PR (spikes, docs, ad-hoc tasks) and must not be blocked.
    """
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(card.id, test_board.id, data)
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_to_done_skips_gate_for_human_actor_with_unmerged_pr(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
):
    """A human moving a card with an unmerged PR also bypasses the gate.

    GitHub is not even contacted when no agent context is set — the gate is
    purely an agent guardrail.
    """
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(card.id, test_board.id, data)
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_within_done_skips_gate(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
):
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(db_session, test_board, gate_board_cols["done"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done2"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(card.id, test_board.id, data)
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done2"].id


async def test_move_card_leaving_done_skips_gate(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
):
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(db_session, test_board, gate_board_cols["done"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["review"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(card.id, test_board.id, data)
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["review"].id


async def test_move_card_to_non_done_column_skips_gate(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
):
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(db_session, test_board, gate_board_cols["backlog"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["review"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(card.id, test_board.id, data)
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["review"].id


async def test_done_gate_fails_soft_after_retry_exhaustion_marks_deferred(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """Retry exhaustion (BadGatewayError) -> allow the move, stamp `verification-deferred` label.

    Pre-fix behavior raised BadGatewayError straight through, stranding cards in
    In-Review when GitHub had a transient 502. Smoke 2026-04-24: card 475e3a6f
    sat stuck for 40+ min while its PR was already merged on main.
    """
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.exceptions import BadGatewayError

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            side_effect=BadGatewayError("nope", error_code="github_unavailable"),
        ):
            moved = await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    assert moved.column_id == gate_board_cols["done"].id
    assert "verification-deferred" in (moved.labels or [])


async def test_done_gate_retries_on_transient_502_then_succeeds(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """The HTTP layer's bounded retry recovers a transient 502 and the gate sees a merged PR.

    Patches httpx at the transport layer (below _request) so the real retry
    loop in GitHubClient._request is exercised end-to-end.
    """
    import httpx
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    responses = [
        httpx.Response(502, json={}),
        httpx.Response(502, json={}),
        httpx.Response(200, json={"merged": True, "mergeable": True, "state": "closed"}),
    ]

    async def fake_send(self, method, url, **kwargs):
        return responses.pop(0)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch.object(
            httpx.AsyncClient, "request", new=fake_send,
        ), patch("asyncio.sleep", new_callable=AsyncMock):
            moved = await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    assert moved.column_id == gate_board_cols["done"].id
    assert "verification-deferred" not in (moved.labels or [])
    # All three HTTP attempts were consumed (2 transient 502 + 1 success).
    assert responses == []


async def test_done_gate_skipped_when_workspace_opted_out(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """Workspace flag `enforce_done_merge_gate=False` -> gate never contacts GitHub."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.models.workspace_config import WorkspaceConfig

    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        enforce_done_merge_gate=False,
    )
    db_session.add(config)
    await db_session.flush()

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_done_gate_default_behavior_unchanged_on_healthy_github(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """No workspace_config row -> flag defaults to True; merged PR passes through cleanly.

    Mirrors test_move_card_to_done_accepts_when_pr_merged but explicitly asserts no
    verification-deferred label and that the gate ran (mock got called).
    """
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=True, mergeable=True, state="closed"),
        ) as mock_status:
            moved = await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    mock_status.assert_called_once()
    assert moved.column_id == gate_board_cols["done"].id
    assert "verification-deferred" not in (moved.labels or [])


# --- Cell #12 (white-label leak, sibling of #11): a non-GitHub PR footer must
# not hard-fail the done-gate. extract_pr_url's `PR:` line matches ANY forge url,
# but GitHubClient.get_pr_status raises ValueError on a non-github.com url
# (github_client.py:89) — which the gate's `except BadGatewayError` does NOT
# catch. A Gitea/GitLab card therefore crashed the move-to-Done. The cure mirrors
# the scheduler's _pr_is_open soft-pass: PR-status gating is OFF for non-GitHub
# forges until a forge-native status client lands (the runner owns the real
# merge), so the move is allowed instead of crashing.
_GITEA_PR_DESC = (
    "Implement feature.\n\n---\nBranch: feat/x\n"
    "PR: https://gitea.example.com/acme/widget/pulls/9\n"
)
_GITLAB_MR_DESC = (
    "Implement feature.\n\n---\nBranch: feat/x\n"
    "PR: https://gitlab.example.com/acme/widget/-/merge_requests/9\n"
)


async def test_done_gate_soft_passes_for_gitea_pr_url(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """A Gitea PR footer must NOT crash the gate with an uncaught ValueError.

    Uses a REAL GitHubClient (no mock) so the actual `get_pr_status` ValueError
    fires — the whole point of the cell is that github_client raises before any
    HTTP for a non-github.com url, and the pre-fix `except BadGatewayError` let it
    escape. Soft-pass: the move into Done is allowed.
    """
    from app.core.auth import current_agent_id

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description=_GITEA_PR_DESC,
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        moved = await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    assert moved.column_id == gate_board_cols["done"].id
    assert MERGE_GATE_UNSUPPORTED_FORGE_LABEL in (moved.labels or [])


async def test_done_gate_soft_passes_for_gitlab_mr_url(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """A GitLab merge-request footer likewise soft-passes (no uncaught ValueError)."""
    from app.core.auth import current_agent_id

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description=_GITLAB_MR_DESC,
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        moved = await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    assert moved.column_id == gate_board_cols["done"].id
    assert MERGE_GATE_UNSUPPORTED_FORGE_LABEL in (moved.labels or [])


async def test_done_gate_non_github_still_enforces_reviewer_approval(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """The forge-specific soft-pass is for the PR-STATUS check ONLY. The reviewer-
    approval backstop (card 7f1d289d) is forge-independent — a workspace-local
    verdict lookup — so an AGENT moving a non-GitHub card with NO approving verdict
    on record must still be rejected with `merge_requires_review`. Without this, a
    Gitea/GitLab card would reach Done with neither merge-proof nor approval,
    reopening the self-merge hole (caught by cell #12's adversarial review)."""
    from app.core.auth import current_agent_id
    from app.exceptions import ConflictError

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description=_GITEA_PR_DESC,
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with pytest.raises(ConflictError) as exc_info:
            await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    assert exc_info.value.error_code == "merge_requires_review"
    await db_session.refresh(card)
    assert card.column_id == gate_board_cols["review"].id


async def test_done_gate_non_github_passes_with_reviewer_approval(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """A non-GitHub card WITH an approving reviewer verdict moves to Done (PR-status
    soft-passed, approval enforced + satisfied) and carries the audit label."""
    from app.core.auth import current_agent_id

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description=_GITEA_PR_DESC,
    )
    await _record_verdict(
        db_session, workspace_id=test_workspace.id, board_id=test_board.id,
        card_id=card.id, user_id=test_user.id, decision="approve",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        moved = await service.move_card(
            card.id, test_board.id, data, workspace_id=test_workspace.id,
        )
    finally:
        current_agent_id.reset(token)

    assert moved.column_id == gate_board_cols["done"].id
    assert MERGE_GATE_UNSUPPORTED_FORGE_LABEL in (moved.labels or [])


async def test_done_gate_still_requires_a_pr_url(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    gate_board_repo,
):
    """No-regression: the soft-pass is for *non-GitHub forge* urls only. A card
    with NO recognizable PR url still hard-fails the gate (`pr_url_missing`) — the
    cure must not turn the gate into a no-op."""
    from app.core.auth import current_agent_id
    from app.exceptions import ValidationError

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="Implement feature.\n\nNo PR here.",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with pytest.raises(ValidationError) as exc:
            await service.move_card(card.id, test_board.id, data)
    finally:
        current_agent_id.reset(token)

    assert exc.value.error_code == "pr_url_missing"


async def test_move_card_same_column_short_circuit_skips_gate(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
):
    """No-op move (same col, same position) must skip the gate entirely."""
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(db_session, test_board, gate_board_cols["done"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=card.position)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        result = await service.move_card(card.id, test_board.id, data)
    mock_status.assert_not_called()
    assert result.id == card.id


# --- SWE security fix (card 7f1d289d): merge-requires-review backstop ---
#
# A merged PR alone does NOT authorize Done. The exact bug being closed: an
# implementer-role agent self-merged its own PR via a Bash escape hatch, with
# zero reviews. The Done-gate is the durable server-side backstop — for an
# agent caller a merged PR is only legitimate when a reviewer verdict that
# *approves* the card is on record. No approval + merged PR = the bug → reject.


async def _record_verdict(
    db_session: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    board_id: uuid.UUID,
    card_id: uuid.UUID,
    user_id: uuid.UUID,
    decision: str,
    findings: list | None = None,
):
    """Seed a review_verdict note the way the reviewer path records it.

    Title format mirrors the Go reviewer client: "Review: {card_id} — {decision}".
    `get_card_verdict` parses the decision out of this title and derives
    `approved` from findings (no BLOCKING) or, when findings are absent, from
    the decision string.
    """
    from app.models.notes.note import Note
    from app.models.notes.kinds import REVIEW_VERDICT

    note = Note(
        workspace_id=workspace_id,
        board_id=board_id,
        card_id=card_id,
        title=f"Review: {card_id} — {decision}",
        content="verdict",
        kind=REVIEW_VERDICT,
        findings=findings,
        created_by=user_id,
    )
    db_session.add(note)
    await db_session.flush()
    return note


async def test_move_card_to_done_rejects_merged_pr_without_reviewer_approval(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """Merged PR + agent caller + NO reviewer verdict on record -> rejected.

    This is the security backstop: even with a genuinely-merged PR, an agent
    cannot drive a card to Done unless the reviewer path approved it.
    """
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.exceptions import ConflictError
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=True, mergeable=True, state="closed"),
        ):
            with pytest.raises(ConflictError) as exc_info:
                await service.move_card(
                    card.id, test_board.id, data, workspace_id=test_workspace.id,
                )
        assert exc_info.value.error_code == "merge_requires_review"
    finally:
        current_agent_id.reset(token)

    await db_session.refresh(card)
    assert card.column_id == gate_board_cols["review"].id


async def test_move_card_to_done_accepts_merged_pr_with_reviewer_approval(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """Merged PR + agent caller + approving reviewer verdict -> move succeeds."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    await _record_verdict(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=card.id,
        user_id=test_user.id,
        decision="approve",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=True, mergeable=True, state="closed"),
        ):
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    assert moved.column_id == gate_board_cols["done"].id


async def test_move_card_to_done_rejects_merged_pr_with_non_approving_verdict(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """A verdict that exists but does NOT approve (request_changes / BLOCKING
    findings) is not authorization to merge. Merged PR alone still rejects."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.exceptions import ConflictError
    from app.models.notes.finding import FindingSeverity
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    await _record_verdict(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=card.id,
        user_id=test_user.id,
        decision="request_changes",
        findings=[{"severity": FindingSeverity.BLOCKING.value, "message": "leaks creds"}],
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=True, mergeable=True, state="closed"),
        ):
            with pytest.raises(ConflictError) as exc_info:
                await service.move_card(
                    card.id, test_board.id, data, workspace_id=test_workspace.id,
                )
        assert exc_info.value.error_code == "merge_requires_review"
    finally:
        current_agent_id.reset(token)

    await db_session.refresh(card)
    assert card.column_id == gate_board_cols["review"].id


async def test_move_card_to_done_unmerged_pr_takes_precedence_over_approval(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """An approving verdict does not let an UNMERGED PR through — the existing
    pr_not_merged check still fires first."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.exceptions import ConflictError
    from app.services.github_client import PRStatus

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    await _record_verdict(
        db_session,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        card_id=card.id,
        user_id=test_user.id,
        decision="approve",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
            return_value=PRStatus(merged=False, mergeable=True, state="open"),
        ):
            with pytest.raises(ConflictError) as exc_info:
                await service.move_card(
                    card.id, test_board.id, data, workspace_id=test_workspace.id,
                )
        assert exc_info.value.error_code == "pr_not_merged"
    finally:
        current_agent_id.reset(token)


async def test_move_card_to_done_human_with_merged_unreviewed_pr_unaffected(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace,
):
    """Humans (no agent context) bypass the whole gate, approval included.

    The merge-requires-review backstop is an agent-only guardrail; a human
    operator may move a merged-but-unreviewed card to Done.
    """
    from unittest.mock import AsyncMock, patch

    card = await _make_gate_card(db_session, test_board, gate_board_cols["review"], test_user)
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
    ) as mock_status:
        moved = await service.move_card(
            card.id, test_board.id, data, workspace_id=test_workspace.id,
        )
    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


# --- Per-board override: boards.enforce_done_merge_gate (NULL/true/false) ---
#
# The workspace flag is one lever for a whole tenant, but the gate is per-board
# in nature: a workspace routinely mixes code boards (gate wanted) with
# ops/doc boards (gate unsatisfiable). NULL inherits the workspace flag, so
# every pre-existing board keeps its current behavior. The structural
# repo-linkage exemption stays supreme — an override of `true` cannot conjure a
# mergeable PR onto a board that has no repo.


async def test_done_gate_skipped_when_board_override_off(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """Board override `false` exempts a repo-linked board with no PR at all."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id

    test_board.enforce_done_merge_gate = False
    await db_session.flush()

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_done_gate_board_override_on_beats_workspace_opt_out(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """Override `true` re-arms the gate on a board whose workspace opted out."""
    from app.core.auth import current_agent_id
    from app.models.workspace_config import WorkspaceConfig

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id, enforce_done_merge_gate=False,
        )
    )
    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with pytest.raises(ValidationError) as exc:
            await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    assert exc.value.error_code == "pr_url_missing"


async def test_done_gate_board_override_null_inherits_workspace_on(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """NULL override + workspace gate ON (no config row) -> gate fires."""
    from app.core.auth import current_agent_id

    assert test_board.enforce_done_merge_gate is None

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with pytest.raises(ValidationError) as exc:
            await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    assert exc.value.error_code == "pr_url_missing"


async def test_done_gate_board_override_null_inherits_workspace_off(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """NULL override + workspace opted out -> gate skipped (inheritance)."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.models.workspace_config import WorkspaceConfig

    db_session.add(
        WorkspaceConfig(
            workspace_id=test_workspace.id, enforce_done_merge_gate=False,
        )
    )
    await db_session.flush()
    assert test_board.enforce_done_merge_gate is None

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_done_gate_repo_less_board_exempt_despite_override_on(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace,
):
    """Structural exemption outranks an explicit `true` override.

    No gate_board_repo fixture here: the board has no linked repo, so it cannot
    produce a mergeable PR and the gate would dead-end every agent move.
    """
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id

    test_board.enforce_done_merge_gate = True
    await db_session.flush()

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id


async def test_done_gate_board_override_off_does_not_read_workspace_config(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """A set override is authoritative: no workspace-config query is issued."""
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id

    test_board.enforce_done_merge_gate = False
    await db_session.flush()

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch.object(
            CardService, "_gate_enabled_for_workspace", new_callable=AsyncMock
        ) as mock_workspace_flag:
            await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_workspace_flag.assert_not_called()


async def test_relax_signal_end_to_end_unblocks_an_agent_move_to_done(
    db_session: AsyncSession, test_board: Board, test_user: User, gate_board_cols,
    test_workspace, gate_board_repo,
):
    """B10 AC8, end to end: the loop-save relax signal writes the override the
    gate actually reads. The two halves are tested apart (the PUT writes false;
    a false override skips the gate) — this pins that they are the SAME value,
    which is the only thing that makes the feature work for the operator.

    Deliberately drives the real BoardService rather than setting the column
    by hand: a stamp written to the workspace flag, or to a different board,
    would pass both halves separately and fail here.
    """
    from unittest.mock import AsyncMock, patch
    from app.core.auth import current_agent_id
    from app.schemas.kanban.loop import LoopConfigPut
    from app.services.kanban.board import BoardService

    await BoardService(db_session).put_loop_config(
        test_board.id,
        test_workspace.id,
        LoopConfigPut(
            loop_prompt="iterate",
            loop_landing="self_merge",
            relax_done_merge_gate=True,
        ),
        actor_id=test_user.id,
    )
    await db_session.refresh(test_board)

    card = await _make_gate_card(
        db_session, test_board, gate_board_cols["review"], test_user,
        description="",
    )
    data = CardMoveRequest(column_id=gate_board_cols["done"].id, position=1024.0)
    service = CardService(db_session)

    token = current_agent_id.set(uuid.uuid4())
    try:
        with patch(
            "app.services.kanban.card.GitHubClient.get_pr_status",
            new_callable=AsyncMock,
        ) as mock_status:
            moved = await service.move_card(
                card.id, test_board.id, data, workspace_id=test_workspace.id,
            )
    finally:
        current_agent_id.reset(token)

    mock_status.assert_not_called()
    assert moved.column_id == gate_board_cols["done"].id
