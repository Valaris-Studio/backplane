# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.activity import ActivityService


async def test_record_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    service = ActivityService(db_session)
    entity_id = uuid.uuid4()

    await service.record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=entity_id,
        action=ActivityAction.created,
        board_id=test_board.id,
        summary="Created card 'My Task'",
        changes={"title": "My Task"},
    )

    activities = await service.list_workspace_activity(test_workspace.id)
    assert len(activities) == 1
    a = activities[0]
    assert a.workspace_id == test_workspace.id
    assert a.actor_id == test_user.id
    assert a.entity_type == ActivityEntityType.card
    assert a.entity_id == entity_id
    assert a.action == ActivityAction.created
    assert a.board_id == test_board.id
    assert a.summary == "Created card 'My Task'"
    assert a.changes == {"title": "My Task"}


async def test_list_workspace_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = ActivityService(db_session)
    now = datetime.now(timezone.utc)

    for i in range(3):
        activity = Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.board,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary=f"Activity {i}",
            created_at=now + timedelta(seconds=i),
        )
        db_session.add(activity)
    await db_session.flush()

    activities = await service.list_workspace_activity(test_workspace.id)
    assert len(activities) == 3
    assert activities[0].summary == "Activity 2"
    assert activities[1].summary == "Activity 1"
    assert activities[2].summary == "Activity 0"


async def test_list_board_activity(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    service = ActivityService(db_session)
    other_board_id = uuid.uuid4()

    await service.record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        board_id=test_board.id,
        summary="On test board",
    )
    # Activity with no board_id (workspace-level) — should not appear
    await service.record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.board,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="No board",
    )

    board_activities = await service.list_board_activity(test_board.id)
    assert len(board_activities) == 1
    assert board_activities[0].summary == "On test board"

    other_activities = await service.list_board_activity(other_board_id)
    assert len(other_activities) == 0


async def test_list_activity_pagination(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = ActivityService(db_session)
    now = datetime.now(timezone.utc)

    for i in range(5):
        activity = Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.board,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary=f"Item {i}",
            created_at=now + timedelta(seconds=i),
        )
        db_session.add(activity)
    await db_session.flush()

    # Test limit
    limited = await service.list_workspace_activity(test_workspace.id, limit=2)
    assert len(limited) == 2
    assert limited[0].summary == "Item 4"
    assert limited[1].summary == "Item 3"

    # Test before cursor
    cursor = limited[1].created_at
    page2 = await service.list_workspace_activity(test_workspace.id, limit=2, before=cursor)
    assert len(page2) == 2
    assert page2[0].summary == "Item 2"
    assert page2[1].summary == "Item 1"


async def test_list_workspace_activity_filter_by_entity_type(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = ActivityService(db_session)
    for entity_type, summary in [
        (ActivityEntityType.card, "Card activity"),
        (ActivityEntityType.board, "Board activity"),
        (ActivityEntityType.card, "Another card activity"),
    ]:
        activity = Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=entity_type,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary=summary,
        )
        db_session.add(activity)
    await db_session.flush()

    results = await service.list_workspace_activity(
        test_workspace.id, entity_type=ActivityEntityType.card
    )
    assert len(results) == 2
    assert all(a.entity_type == ActivityEntityType.card for a in results)


async def test_list_workspace_activity_filter_by_action(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = ActivityService(db_session)
    for action, summary in [
        (ActivityAction.created, "Created something"),
        (ActivityAction.updated, "Updated something"),
        (ActivityAction.deleted, "Deleted something"),
    ]:
        activity = Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.board,
            entity_id=uuid.uuid4(),
            action=action,
            summary=summary,
        )
        db_session.add(activity)
    await db_session.flush()

    results = await service.list_workspace_activity(
        test_workspace.id, action=ActivityAction.updated
    )
    assert len(results) == 1
    assert results[0].action == ActivityAction.updated
    assert results[0].summary == "Updated something"


async def test_list_workspace_activity_filter_by_search(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = ActivityService(db_session)
    for summary in ["created card 'Login Form'", "updated board 'Sprint'", "deleted card 'Signup'"]:
        activity = Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary=summary,
        )
        db_session.add(activity)
    await db_session.flush()

    results = await service.list_workspace_activity(test_workspace.id, search="card")
    assert len(results) == 2
    assert all("card" in a.summary for a in results)


async def test_list_workspace_activity_filter_combined(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    service = ActivityService(db_session)
    # card + created
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="created card 'A'",
    ))
    # card + updated
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.updated, summary="updated card 'B'",
    ))
    # board + created
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.board, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="created board 'C'",
    ))
    await db_session.flush()

    results = await service.list_workspace_activity(
        test_workspace.id,
        entity_type=ActivityEntityType.card,
        action=ActivityAction.created,
    )
    assert len(results) == 1
    assert results[0].summary == "created card 'A'"


async def test_list_board_activity_with_filters(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace, test_board: Board
):
    service = ActivityService(db_session)
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        board_id=test_board.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="created card on board",
    ))
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        board_id=test_board.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.moved, summary="moved card on board",
    ))
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        board_id=test_board.id,
        entity_type=ActivityEntityType.board, entity_id=uuid.uuid4(),
        action=ActivityAction.updated, summary="updated board settings",
    ))
    await db_session.flush()

    results = await service.list_board_activity(
        test_board.id, entity_type=ActivityEntityType.card, action=ActivityAction.created
    )
    assert len(results) == 1
    assert results[0].summary == "created card on board"

    search_results = await service.list_board_activity(test_board.id, search="moved")
    assert len(search_results) == 1
    assert search_results[0].summary == "moved card on board"


async def test_recording_an_activity_flushes_it_into_the_caller_transaction(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """The premise every best-effort activity savepoint rests on (card B5).

    `ActivityRepository.record` FLUSHES rather than leaving the row pending
    until commit. That is deliberate — `seq` and `created_at` ordering are read
    back within the request — but it means a row the DATABASE rejects fails
    INSIDE the caller's transaction, not at commit time. Callers that swallow
    activity errors (`LoopTemplateService._record_activity`,
    `AgentService._record_lifecycle_activity`) must therefore bound the failure
    with `db.begin_nested()`; a bare try/except leaves the session
    rollback-only and silently discards the write the request was for.

    If this ever stops flushing, those savepoints become dead weight — and the
    tests that prove them would go quietly vacuous.
    """
    before = (
        await db_session.execute(
            select(func.count()).select_from(Activity).where(Activity.id.isnot(None))
        )
    ).scalar_one()

    await ActivityService(db_session).record(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="flush premise",
        message_key="activity.card.created",
        message_params={},
    )

    # No commit and no explicit flush: the row is visible to a query on this
    # session only because the repository already flushed it.
    after = (
        await db_session.execute(
            select(func.count()).select_from(Activity).where(Activity.id.isnot(None))
        )
    ).scalar_one()
    assert after == before + 1
