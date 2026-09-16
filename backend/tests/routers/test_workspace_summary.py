# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.channels.channel import Channel, ChannelType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/summary"


async def test_get_summary_success(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    board1 = Board(
        workspace_id=test_workspace.id,
        name="Board 1",
        created_by=test_user.id,
    )
    board2 = Board(
        workspace_id=test_workspace.id,
        name="Board 2",
        created_by=test_user.id,
    )
    db_session.add_all([board1, board2])
    await db_session.flush()

    col = Column(board_id=board1.id, name="To Do", position=1024.0, color="#6b7280")
    db_session.add(col)
    await db_session.flush()

    for i in range(5):
        card = Card(
            board_id=board1.id,
            column_id=col.id,
            title=f"Card {i}",
            position=1024.0 * (i + 1),
            created_by=test_user.id,
        )
        db_session.add(card)
    await db_session.flush()

    # Workspace-level notes (board_id=NULL) — these should be counted
    for i in range(3):
        note = Note(
            workspace_id=test_workspace.id,
            board_id=None,
            title=f"WS Note {i}",
            content="",
            created_by=test_user.id,
        )
        db_session.add(note)
    await db_session.flush()

    channel = Channel(
        workspace_id=test_workspace.id,
        name="Slack",
        channel_type=ChannelType.slack,
        contact_value="https://slack.com/channel",
        created_by=test_user.id,
    )
    db_session.add(channel)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    for i in range(3):
        activity = Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary=f"Activity {i}",
            created_at=now + timedelta(seconds=i),
        )
        db_session.add(activity)
    await db_session.flush()

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()

    assert data["board_count"] == 2
    assert data["card_count"] == 5
    assert data["note_count"] == 3
    assert data["channel_count"] == 1

    assert len(data["recent_activity"]) == 3
    # Most recent first
    assert data["recent_activity"][0]["summary"] == "Activity 2"
    assert data["recent_activity"][1]["summary"] == "Activity 1"
    assert data["recent_activity"][2]["summary"] == "Activity 0"

    # Verify activity items have the expected schema fields
    activity_item = data["recent_activity"][0]
    assert "id" in activity_item
    assert "workspace_id" in activity_item
    assert "actor_id" in activity_item
    assert "entity_type" in activity_item
    assert "action" in activity_item
    assert "created_at" in activity_item


async def test_get_summary_empty_workspace(
    client: AsyncClient,
    test_workspace: Workspace,
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()

    assert data["board_count"] == 0
    assert data["card_count"] == 0
    assert data["note_count"] == 0
    assert data["channel_count"] == 0
    assert data["recent_activity"] == []


async def test_get_summary_nonexistent_workspace(client: AsyncClient):
    response = await client.get("/api/workspaces/nonexistent/summary")
    assert response.status_code == 404


async def test_get_summary_counts_only_workspace_notes(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    board = Board(
        workspace_id=test_workspace.id,
        name="Board",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()

    # Board-scoped note — should NOT be counted in summary
    board_note = Note(
        workspace_id=test_workspace.id,
        board_id=board.id,
        title="Board Note",
        content="Scoped to board",
        created_by=test_user.id,
    )
    db_session.add(board_note)
    await db_session.flush()

    # Workspace-level notes (board_id=NULL) — should be counted
    ws_note1 = Note(
        workspace_id=test_workspace.id,
        board_id=None,
        title="WS Note 1",
        content="",
        created_by=test_user.id,
    )
    ws_note2 = Note(
        workspace_id=test_workspace.id,
        board_id=None,
        title="WS Note 2",
        content="",
        created_by=test_user.id,
    )
    db_session.add_all([ws_note1, ws_note2])
    await db_session.flush()

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    data = response.json()

    # Only workspace-level notes counted
    assert data["note_count"] == 2


async def test_get_summary_serializes_activity_trend(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    now = datetime.now(timezone.utc)
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

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    trend = response.json()["activity_trend"]

    assert len(trend) == 30
    assert trend[-1]["day"] == now.date().isoformat()
    assert trend[-1]["count"] == 1
    assert trend[0]["count"] == 0
