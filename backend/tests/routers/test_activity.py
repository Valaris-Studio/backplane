# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.user import User
from app.models.workspace import Workspace


async def test_list_workspace_activity_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    assert response.json() == []


async def test_list_workspace_activity(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    now = datetime.now(timezone.utc)
    for i in range(3):
        db_session.add(
            Activity(
                workspace_id=test_workspace.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.board,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary=f"Activity {i}",
                created_at=now + timedelta(seconds=i),
            )
        )
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 3
    assert data[0]["summary"] == "Activity 2"
    assert data[0]["entity_type"] == "board"
    assert data[0]["action"] == "created"


async def test_list_board_activity(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.moved,
            summary="Moved card",
        )
    )
    # Workspace-level activity (no board_id) — should not appear on board endpoint
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.board,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="Created board",
        )
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/history"
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["summary"] == "Moved card"
    assert data[0]["board_id"] == str(test_board.id)


async def test_list_activity_with_limit(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    now = datetime.now(timezone.utc)
    for i in range(10):
        db_session.add(
            Activity(
                workspace_id=test_workspace.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.board,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary=f"Item {i}",
                created_at=now + timedelta(seconds=i),
            )
        )
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history?limit=3")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 3
    assert data[0]["summary"] == "Item 9"


async def test_list_activity_filter_by_entity_type(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="Card thing",
    ))
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.board, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="Board thing",
    ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history?entity_type=card")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["entity_type"] == "card"
    assert data[0]["summary"] == "Card thing"


async def test_list_activity_filter_by_action(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="Created card",
    ))
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.moved, summary="Moved card",
    ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history?action=moved")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["action"] == "moved"
    assert data[0]["summary"] == "Moved card"


async def test_list_activity_filter_by_search(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="created card 'Login'",
    ))
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.board, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="created board 'Sprint'",
    ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history?search=Login")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert "Login" in data[0]["summary"]


async def test_list_activity_response_includes_actor_info(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    db_session.add(Activity(
        workspace_id=test_workspace.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.board, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="Some activity",
    ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["actor_name"] == "Dev User"
    assert data[0]["actor_email"] == "dev@valaris.dev"


async def test_history_response_includes_null_snapshot_fields(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Backward-compat: the existing /history endpoint gains additive, always-
    present nullable before_state/after_state keys without changing prior
    behavior. Legacy rows (no snapshots) serialize them as null."""
    db_session.add(Activity(
        workspace_id=test_workspace.id, board_id=test_board.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=uuid.uuid4(),
        action=ActivityAction.created, summary="Legacy row",
    ))
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/history"
    )
    assert response.status_code == 200
    item = response.json()[0]
    assert "before_state" in item
    assert "after_state" in item
    assert item["before_state"] is None
    assert item["after_state"] is None
    # prior fields untouched
    assert item["summary"] == "Legacy row"
    assert item["changes"] is None


async def test_history_response_includes_entity_title_for_card(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    db_session.add(Activity(
        workspace_id=test_workspace.id, board_id=test_board.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.card, entity_id=test_card.id,
        action=ActivityAction.updated, summary="Updated card",
    ))
    await db_session.flush()

    response = await client.get("/api/workspaces/default/history")
    assert response.status_code == 200
    item = response.json()[0]
    assert item["entity_title"] == test_card.title


async def test_board_history_response_entity_title_none_for_board_row(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    db_session.add(Activity(
        workspace_id=test_workspace.id, board_id=test_board.id, actor_id=test_user.id,
        entity_type=ActivityEntityType.board, entity_id=test_board.id,
        action=ActivityAction.updated, summary="Board setting change",
    ))
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/history"
    )
    assert response.status_code == 200
    item = response.json()[0]
    assert "entity_title" in item
    assert item["entity_title"] is None
