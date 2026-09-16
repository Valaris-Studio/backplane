# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.channels.channel import Channel, ChannelType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.services.workspace import WorkspaceService


async def test_get_summary_delegates_to_repos(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    service = WorkspaceService(db_session)

    board = Board(
        workspace_id=test_workspace.id,
        name="Board A",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()

    col = Column(board_id=board.id, name="Backlog", position=1024.0, color="#6b7280")
    db_session.add(col)
    await db_session.flush()

    card = Card(
        board_id=board.id,
        column_id=col.id,
        title="Task 1",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    note = Note(
        workspace_id=test_workspace.id,
        board_id=None,
        title="Workspace Note",
        content="",
        created_by=test_user.id,
    )
    db_session.add(note)
    await db_session.flush()

    channel = Channel(
        workspace_id=test_workspace.id,
        name="Email",
        channel_type=ChannelType.email,
        contact_value="team@valaris.dev",
        created_by=test_user.id,
    )
    db_session.add(channel)
    await db_session.flush()

    activity = Activity(
        workspace_id=test_workspace.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.board,
        entity_id=board.id,
        action=ActivityAction.created,
        summary="Created board",
    )
    db_session.add(activity)
    await db_session.flush()

    summary = await service.get_summary(test_workspace.id)

    assert summary["board_count"] == 1
    assert summary["card_count"] == 1
    assert summary["note_count"] == 1
    assert summary["channel_count"] == 1
    assert len(summary["recent_activity"]) == 1
    assert summary["recent_activity"][0].summary == "Created board"


async def test_get_summary_limits_activity_to_five(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    service = WorkspaceService(db_session)
    now = datetime.now(timezone.utc)

    for i in range(10):
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

    summary = await service.get_summary(test_workspace.id)

    assert len(summary["recent_activity"]) == 5
    # Most recent first
    assert summary["recent_activity"][0].summary == "Activity 9"
    assert summary["recent_activity"][4].summary == "Activity 5"


async def test_get_summary_includes_activity_trend_buckets(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    service = WorkspaceService(db_session)
    now = datetime.now(timezone.utc)

    for _ in range(3):
        db_session.add(
            Activity(
                workspace_id=test_workspace.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.board,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary="Today",
                created_at=now,
            )
        )
    await db_session.flush()

    summary = await service.get_summary(test_workspace.id)

    trend = summary["activity_trend"]
    assert len(trend) == 30
    # Oldest first; today is the last bucket and carries every seeded row.
    assert trend[-1]["count"] == 3
    assert sum(bucket["count"] for bucket in trend) == 3
    assert trend[-1]["day"] == now.date()
