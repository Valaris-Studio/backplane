# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.definitions.definition import Definition
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, Priority
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace


def _context_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/context"


async def test_get_board_context_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Minimal board with one column and two cards returns correct summary."""
    card1 = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Card A",
        position=1024.0,
        priority=Priority.high,
        status="working",
        created_by=test_user.id,
    )
    card2 = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Card B",
        position=2048.0,
        priority=Priority.none,
        status=None,
        created_by=test_user.id,
    )
    db_session.add_all([card1, card2])
    await db_session.flush()

    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    # Board summary
    board = data["board"]
    assert board["id"] == str(test_board.id)
    assert board["name"] == "Test Board"
    assert board["total_cards"] == 2

    # Column summary
    assert len(board["columns"]) == 1
    col = board["columns"][0]
    assert col["id"] == str(test_column.id)
    assert col["card_count"] == 2
    assert col["priority_distribution"]["high"] == 1
    assert col["priority_distribution"]["none"] == 1
    assert col["status_distribution"]["working"] == 1
    assert col["status_distribution"]["null"] == 1

    # Empty sub-collections by default
    assert data["definition"] is None
    assert data["notes"] == []
    assert data["git_repos"] == []
    assert data["recent_activity"] == []


async def test_get_board_context_with_definition(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_definition: Definition,
):
    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    defn = data["definition"]
    assert defn is not None
    assert defn["scope"] == "Build the MVP"
    assert defn["content"] == {"tech_stack": ["Python"]}


async def test_get_board_context_with_notes_and_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_note: Note,
    test_user: User,
    db_session: AsyncSession,
):
    activity = Activity(
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary="created card 'Test'",
    )
    db_session.add(activity)
    await db_session.flush()

    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["notes"]) == 1
    assert data["notes"][0]["title"] == "Test Note"

    assert len(data["recent_activity"]) == 1
    act = data["recent_activity"][0]
    assert act["action"] == "created"
    assert act["summary"] == "created card 'Test'"


async def test_get_board_context_with_git_repos(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_git_repo: GitRepo,
):
    response = await client.get(_context_url(test_board.id))
    assert response.status_code == 200
    data = response.json()

    assert len(data["git_repos"]) == 1
    repo = data["git_repos"][0]
    assert repo["name"] == "Test Repo"
    assert repo["url"] == "https://github.com/valaris/test-repo"
    assert repo["provider"] == "github"
    assert repo["default_branch"] == "main"


async def test_get_board_context_nonexistent_board(
    client: AsyncClient,
    test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.get(_context_url(fake_id))
    assert response.status_code == 404
