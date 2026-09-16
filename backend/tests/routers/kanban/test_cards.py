# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


def _url(board: Board, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/cards{suffix}"


async def _make_repo(
    db: AsyncSession, board: Board, user: User, *, slug: str
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name=slug,
        slug=slug,
        url=f"https://github.com/acme/{slug}",
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def test_create_card_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={"title": "New Card", "column_id": str(test_column.id)},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "New Card"
    assert data["column_id"] == str(test_column.id)
    assert data["board_id"] == str(test_board.id)
    assert data["card_type"] == "task"
    assert data["priority"] == "none"


async def test_create_card_with_options(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "Bug Report",
            "description": "Something is broken",
            "card_type": "bug",
            "priority": "high",
            "column_id": str(test_column.id),
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Bug Report"
    # Descriptions normalize to canonical PM JSON on write (editor P0-3).
    description_doc = json.loads(data["description"])
    assert description_doc["type"] == "doc"
    assert (
        description_doc["content"][0]["content"][0]["text"]
        == "Something is broken"
    )
    assert data["card_type"] == "bug"
    assert data["priority"] == "high"


async def test_create_card_invalid_column(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    fake_column_id = uuid.uuid4()
    response = await client.post(
        _url(test_board),
        json={"title": "Orphan", "column_id": str(fake_column_id)},
    )
    assert response.status_code == 404


async def test_get_card_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_card.id)
    assert data["title"] == "Test Card"


async def test_get_card_not_found(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    fake_id = uuid.uuid4()
    response = await client.get(_url(test_board, f"/{fake_id}"))
    assert response.status_code == 404


async def test_update_card_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"title": "Updated Card", "priority": "urgent"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Updated Card"
    assert data["priority"] == "urgent"


async def test_delete_card_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.delete(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 204

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 404


async def test_move_card_same_column(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}/move"),
        json={"column_id": str(test_column.id), "position": 512.0},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["column_id"] == str(test_column.id)
    assert data["position"] == 512.0


async def test_move_card_to_different_column(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    db_session: AsyncSession,
):
    second_column = Column(board_id=test_board.id, name="In Progress", position=2048.0)
    db_session.add(second_column)
    await db_session.flush()

    response = await client.patch(
        _url(test_board, f"/{test_card.id}/move"),
        json={"column_id": str(second_column.id), "position": 1024.0},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["column_id"] == str(second_column.id)
    assert data["position"] == 1024.0


async def test_move_card_invalid_column(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    fake_column_id = uuid.uuid4()
    response = await client.patch(
        _url(test_board, f"/{test_card.id}/move"),
        json={"column_id": str(fake_column_id), "position": 1024.0},
    )
    assert response.status_code == 404


async def test_move_card_with_board_slug_in_url(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    response = await client.patch(
        f"{BASE}/{test_board.slug}/cards/{test_card.id}/move",
        json={"column_id": str(test_column.id), "position": 512.0},
    )
    assert response.status_code == 200


async def test_create_card_with_board_slug_in_url(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        f"{BASE}/{test_board.slug}/cards",
        json={"title": "Slug Created", "column_id": str(test_column.id)},
    )
    assert response.status_code == 201
    assert response.json()["board_id"] == str(test_board.id)


# --- Tests for expanded card fields: due_date, status, labels ---


async def test_create_card_with_due_date(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "Card with due date",
            "column_id": str(test_column.id),
            "due_date": "2025-12-31",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Card with due date"
    assert data["due_date"] == "2025-12-31"


async def test_create_card_with_status(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "Card with status",
            "column_id": str(test_column.id),
            "status": "in_progress",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Card with status"
    assert data["status"] == "in_progress"


async def test_create_card_with_labels(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "Card with labels",
            "column_id": str(test_column.id),
            "labels": ["frontend", "urgent"],
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "Card with labels"
    assert data["labels"] == ["frontend", "urgent"]


async def test_create_card_all_new_fields(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "Full card",
            "column_id": str(test_column.id),
            "due_date": "2025-12-31",
            "status": "blocked",
            "labels": ["backend", "critical"],
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["due_date"] == "2025-12-31"
    assert data["status"] == "blocked"
    assert data["labels"] == ["backend", "critical"]


async def test_update_card_due_date(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"due_date": "2025-12-31"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["due_date"] == "2025-12-31"

    # Clear due_date
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"due_date": None},
    )
    assert response.status_code == 200
    assert response.json()["due_date"] is None


async def test_update_card_status(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": "done"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "done"

    # Clear status
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": None},
    )
    assert response.status_code == 200
    assert response.json()["status"] is None


async def test_update_card_labels(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"labels": ["frontend", "urgent"]},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["labels"] == ["frontend", "urgent"]

    # Update labels to different set
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"labels": ["backend"]},
    )
    assert response.status_code == 200
    assert response.json()["labels"] == ["backend"]


async def test_patch_card_with_pr_url_persists(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    pr_url = "https://github.com/acme/repo/pull/42"
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"pr_url": pr_url},
    )
    assert response.status_code == 200
    assert response.json()["pr_url"] == pr_url

    # Re-fetch to confirm persistence across the request boundary.
    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    assert response.json()["pr_url"] == pr_url


async def test_patch_card_with_branch_name_persists(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    branch = "runner/feat-pr-url-column"
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"branch_name": branch},
    )
    assert response.status_code == 200
    assert response.json()["branch_name"] == branch

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    assert response.json()["branch_name"] == branch


async def test_create_card_with_git_repo_slug_persists(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Multi-repo boards: a card declares which repo it targets at creation."""
    await _make_repo(db_session, test_board, test_user, slug="frontend")
    response = await client.post(
        _url(test_board),
        json={
            "title": "frontend card",
            "column_id": str(test_column.id),
            "git_repo_slug": "frontend",
        },
    )
    assert response.status_code == 201
    assert response.json()["git_repo_slug"] == "frontend"


async def test_create_card_unknown_git_repo_slug_stored_null(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """A slug matching no board repo is OMITTED (NULL → board-primary default)
    instead of stored verbatim — a stale runner-stamped slug would park the
    new card forever at assignment time. Never 422 (agent retries stay
    idempotent)."""
    await _make_repo(db_session, test_board, test_user, slug="alpha")
    response = await client.post(
        _url(test_board),
        json={
            "title": "stale slug card",
            "column_id": str(test_column.id),
            "git_repo_slug": "ghost",
        },
    )
    assert response.status_code == 201
    assert response.json()["git_repo_slug"] is None


async def test_create_card_unknown_git_repo_slug_records_activity(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    db_session: AsyncSession,
):
    """Dropping an unknown slug must be loud: an activity entry names the
    rejected slug so operators can see the misroute."""
    await _make_repo(db_session, test_board, test_user, slug="alpha")
    response = await client.post(
        _url(test_board),
        json={
            "title": "stale slug card",
            "column_id": str(test_column.id),
            "git_repo_slug": "ghost",
        },
    )
    assert response.status_code == 201
    card_id = uuid.UUID(response.json()["id"])

    result = await db_session.execute(
        select(Activity).where(Activity.entity_id == card_id)
    )
    summaries = [a.summary for a in result.scalars().all()]
    assert any("ghost" in s for s in summaries), summaries


async def test_create_card_unknown_git_repo_slug_no_repos_on_board(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    """Boards with zero registered repos: any slug is unknown → NULL, 201."""
    response = await client.post(
        _url(test_board),
        json={
            "title": "no repos here",
            "column_id": str(test_column.id),
            "git_repo_slug": "anything",
        },
    )
    assert response.status_code == 201
    assert response.json()["git_repo_slug"] is None


async def test_create_card_without_git_repo_slug_is_null(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    """Default (single-repo boards): git_repo_slug is null when omitted."""
    response = await client.post(
        _url(test_board),
        json={"title": "plain card", "column_id": str(test_column.id)},
    )
    assert response.status_code == 201
    assert response.json()["git_repo_slug"] is None


async def test_patch_card_with_git_repo_slug_persists(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"git_repo_slug": "backend"},
    )
    assert response.status_code == 200
    assert response.json()["git_repo_slug"] == "backend"

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    assert response.json()["git_repo_slug"] == "backend"


async def test_get_card_returns_pr_url_field(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    body = response.json()
    # Both fields must be present in the schema even on an untouched card.
    assert "pr_url" in body
    assert "branch_name" in body
    assert body["pr_url"] is None
    assert body["branch_name"] is None


# --- Tests for card participants ---


async def test_add_participant(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "hero"},
    )
    assert response.status_code == 201
    data = response.json()
    assert len(data["participants"]) == 1
    assert data["participants"][0]["user_id"] == str(second_user.id)
    assert data["participants"][0]["role"] == "hero"
    assert "user" in data["participants"][0]


async def test_add_participant_viewer(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "viewer"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["participants"][0]["role"] == "viewer"


async def test_add_duplicate_participant(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "viewer"},
    )
    # Idempotent: adding the same user again returns 201 with existing card
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "helper"},
    )
    assert response.status_code == 201
    data = response.json()
    participant = next(
        p for p in data["participants"] if p["user_id"] == str(second_user.id)
    )
    assert participant["role"] == "viewer"  # keeps original role


async def test_add_second_hero(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "hero"},
    )
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(test_user.id), "role": "hero"},
    )
    assert response.status_code == 409


async def test_remove_participant(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "viewer"},
    )
    response = await client.delete(
        _url(test_board, f"/{test_card.id}/participants/{second_user.id}"),
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["participants"]) == 0


async def test_remove_participant_not_found(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    response = await client.delete(
        _url(test_board, f"/{test_card.id}/participants/{second_user.id}"),
    )
    assert response.status_code == 204


async def test_remove_participants_by_pipeline_role(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
    second_user: User,
):
    """DELETE .../participants/by-pipeline-role/{role} clears the matching stage."""
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "helper",
            "pipeline_role": "implementer",
        },
    )
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(test_user.id),
            "role": "viewer",
            "pipeline_role": "reviewer",
        },
    )
    response = await client.delete(
        _url(test_board, f"/{test_card.id}/participants/by-pipeline-role/implementer"),
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["participants"]) == 1
    assert data["participants"][0]["pipeline_role"] == "reviewer"


async def test_remove_participants_by_pipeline_role_no_match_returns_204(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    """Idempotent: no participant with that pipeline_role -> 204, not 404."""
    response = await client.delete(
        _url(test_board, f"/{test_card.id}/participants/by-pipeline-role/implementer"),
    )
    assert response.status_code == 204


async def test_card_participants_in_response(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    second_user: User,
):
    """Newly created cards have empty participants list."""
    response = await client.post(
        _url(test_board),
        json={"title": "New Card", "column_id": str(test_column.id)},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["participants"] == []
    assert "assignee_id" not in data


async def test_claim_card_success(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Claiming a card assigns the agent as hero and moves to the active column."""
    from app.models.agents.agent import Agent, AgentType
    from app.models.kanban.column import ColumnType

    # Create the active-typed column (name is display-only for claim purposes).
    in_progress = Column(
        board_id=test_board.id,
        name="In Progress",
        position=2048.0,
        color="#3b82f6",
        column_type=ColumnType.active,
    )
    db_session.add(in_progress)

    # Create an agent owned by test_user.
    agent = Agent(
        name="test-agent", agent_type=AgentType.coding, created_by_id=test_user.id
    )
    db_session.add(agent)
    await db_session.flush()

    # Create a card in To Do.
    response = await client.post(
        _url(test_board),
        json={"title": "Claimable Card", "column_id": str(test_column.id)},
    )
    assert response.status_code == 201
    card_id = response.json()["id"]

    # Claim it.
    response = await client.post(
        _url(test_board, f"/{card_id}/claim"),
        json={"agent_id": str(agent.id)},
    )
    assert response.status_code == 200
    data = response.json()
    assert len(data["participants"]) == 1
    assert data["participants"][0]["role"] == "hero"
    assert data["participants"][0]["user_id"] == str(test_user.id)
    assert data["participants"][0]["agent_id"] == str(agent.id)
    assert data["participants"][0]["agent"]["name"] == "test-agent"
    assert data["column_id"] == str(in_progress.id)


async def test_claim_card_moves_to_active_typed_column_regardless_of_name(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Claim resolves the target by column_type=active, never by column NAME."""
    from app.models.agents.agent import Agent, AgentType
    from app.models.kanban.column import ColumnType

    doing = Column(
        board_id=test_board.id,
        name="Doing",
        position=2048.0,
        color="#3b82f6",
        column_type=ColumnType.active,
    )
    db_session.add(doing)
    agent = Agent(
        name="typed-agent", agent_type=AgentType.coding, created_by_id=test_user.id
    )
    db_session.add(agent)
    await db_session.flush()

    response = await client.post(
        _url(test_board),
        json={"title": "Typed Claim", "column_id": str(test_column.id)},
    )
    card_id = response.json()["id"]

    response = await client.post(
        _url(test_board, f"/{card_id}/claim"),
        json={"agent_id": str(agent.id)},
    )
    assert response.status_code == 200
    assert response.json()["column_id"] == str(doing.id)


async def test_claim_card_conflict(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Claiming an already-claimed card returns 409."""
    from app.models.agents.agent import Agent, AgentType

    agent_a = Agent(
        name="agent-a", agent_type=AgentType.coding, created_by_id=test_user.id
    )
    agent_b = Agent(
        name="agent-b", agent_type=AgentType.coding, created_by_id=test_user.id
    )
    db_session.add_all([agent_a, agent_b])
    await db_session.flush()

    response = await client.post(
        _url(test_board),
        json={"title": "Already Claimed", "column_id": str(test_column.id)},
    )
    card_id = response.json()["id"]

    # First claim succeeds.
    response = await client.post(
        _url(test_board, f"/{card_id}/claim"),
        json={"agent_id": str(agent_a.id)},
    )
    assert response.status_code == 200

    # Second claim fails.
    response = await client.post(
        _url(test_board, f"/{card_id}/claim"),
        json={"agent_id": str(agent_b.id)},
    )
    assert response.status_code == 409


# --- Fix A.1.1: add_participant with agent_id ---


async def test_add_participant_with_agent_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """POST /participants with agent_id resolves the agent's owner as participant."""
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(
        name="route-agent", agent_type=AgentType.coding, created_by_id=test_user.id
    )
    db_session.add(agent)
    await db_session.flush()

    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(test_user.id), "role": "hero", "agent_id": str(agent.id)},
    )
    assert response.status_code == 201
    data = response.json()
    assert len(data["participants"]) == 1
    assert data["participants"][0]["user_id"] == str(test_user.id)
    assert data["participants"][0]["agent_id"] == str(agent.id)


async def test_add_participant_with_agent_id_idempotent(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """Adding the same agent_id twice returns 201 with existing participant."""
    from app.models.agents.agent import Agent, AgentType

    agent = Agent(
        name="idem-route-agent", agent_type=AgentType.coding, created_by_id=test_user.id
    )
    db_session.add(agent)
    await db_session.flush()

    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(test_user.id), "role": "hero", "agent_id": str(agent.id)},
    )
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(test_user.id),
            "role": "viewer",
            "agent_id": str(agent.id),
        },
    )
    assert response.status_code == 201
    data = response.json()
    participant = next(
        p for p in data["participants"] if p["user_id"] == str(test_user.id)
    )
    assert participant["role"] == "hero"  # keeps original role


async def test_add_participant_with_invalid_agent_id(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """POST /participants with nonexistent agent_id returns 404."""
    fake_agent_id = str(uuid.uuid4())
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(test_user.id),
            "role": "viewer",
            "agent_id": fake_agent_id,
        },
    )
    assert response.status_code == 404


# --- F-14 follow-up: pipeline_role on the wire ---


async def test_add_participant_pipeline_role_round_trip(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """POST with pipeline_role surfaces on the participant row."""
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "hero",
            "pipeline_role": "implementer",
        },
    )
    assert response.status_code == 201
    participant = response.json()["participants"][0]
    assert participant["pipeline_role"] == "implementer"


async def test_add_participant_without_pipeline_role_is_null(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Omitting pipeline_role leaves the column NULL (back-compat)."""
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "hero"},
    )
    assert response.status_code == 201
    assert response.json()["participants"][0]["pipeline_role"] is None


async def test_add_participant_idempotent_backfills_null_pipeline_role(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Second POST with a pipeline_role backfills the existing NULL row."""
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={"user_id": str(second_user.id), "role": "hero"},
    )
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "hero",
            "pipeline_role": "reviewer",
        },
    )
    assert response.status_code == 201
    participant = next(
        p
        for p in response.json()["participants"]
        if p["user_id"] == str(second_user.id)
    )
    assert participant["pipeline_role"] == "reviewer"


async def test_add_participant_idempotent_keeps_existing_pipeline_role(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """A conflicting non-NULL pipeline_role does NOT overwrite the original."""
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "hero",
            "pipeline_role": "reviewer",
        },
    )
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "hero",
            "pipeline_role": "documentator",
        },
    )
    assert response.status_code == 201
    participant = next(
        p
        for p in response.json()["participants"]
        if p["user_id"] == str(second_user.id)
    )
    assert participant["pipeline_role"] == "reviewer"


async def test_add_participant_idempotent_same_pipeline_role_returns_200(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    second_user: User,
):
    """Repeating the identical request is a no-op (still 201, no change)."""
    await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "hero",
            "pipeline_role": "reviewer",
        },
    )
    response = await client.post(
        _url(test_board, f"/{test_card.id}/participants"),
        json={
            "user_id": str(second_user.id),
            "role": "hero",
            "pipeline_role": "reviewer",
        },
    )
    assert response.status_code == 201
    participants = [
        p
        for p in response.json()["participants"]
        if p["user_id"] == str(second_user.id)
    ]
    assert len(participants) == 1
    assert participants[0]["pipeline_role"] == "reviewer"


# --- Phase 2: HTTP integration for backend-owned merge gate ---


async def _make_done_column(db_session: AsyncSession, board: Board) -> Column:
    from app.models.kanban.column import ColumnType

    col = Column(
        board_id=board.id,
        name="Done",
        position=4096.0,
        column_type=ColumnType.done,
    )
    db_session.add(col)
    await db_session.flush()
    return col


_PR_DESC_HTTP = (
    "Body.\n\n---\nBranch: feat/y\n" "PR: https://github.com/acme/widget/pull/11\n"
)


async def test_move_card_to_done_returns_200_for_human_with_unmerged_pr(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from unittest.mock import AsyncMock, patch
    from app.services.github_client import PRStatus

    done_col = await _make_done_column(db_session, test_board)
    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="PR unmerged",
        description=_PR_DESC_HTTP,
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    # Human caller (default test client uses X-User-Email auth, no agent
    # context) is allowed to move cards to Done regardless of PR state. The
    # Done-merge gate is an agent-only guardrail; see services/kanban/test_card
    # for the agent-path coverage. GitHub is never even consulted here.
    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
        return_value=PRStatus(merged=False, mergeable=True, state="open"),
    ) as mock_status:
        response = await client.patch(
            _url(test_board, f"/{card.id}/move"),
            json={"column_id": str(done_col.id), "position": 1024.0},
        )
    mock_status.assert_not_called()
    assert response.status_code == 200
    assert response.json()["column_id"] == str(done_col.id)


async def test_move_card_to_done_returns_200_when_pr_merged(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    from unittest.mock import AsyncMock, patch
    from app.services.github_client import PRStatus

    done_col = await _make_done_column(db_session, test_board)
    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="PR merged",
        description=_PR_DESC_HTTP,
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    with patch(
        "app.services.kanban.card.GitHubClient.get_pr_status",
        new_callable=AsyncMock,
        return_value=PRStatus(merged=True, mergeable=True, state="closed"),
    ):
        response = await client.patch(
            _url(test_board, f"/{card.id}/move"),
            json={"column_id": str(done_col.id), "position": 1024.0},
        )
    assert response.status_code == 200
    assert response.json()["column_id"] == str(done_col.id)


async def test_move_card_to_done_returns_200_for_human_without_pr_url(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Humans don't need a PR association at all to move cards to Done.

    Many human-driven cards (spikes, docs, ad-hoc tasks) never have a PR;
    blocking them would break the manual workflow. The Done-merge gate is an
    agent-only guardrail.
    """
    done_col = await _make_done_column(db_session, test_board)
    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="No PR",
        description="",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    response = await client.patch(
        _url(test_board, f"/{card.id}/move"),
        json={"column_id": str(done_col.id), "position": 1024.0},
    )
    assert response.status_code == 200
    assert response.json()["column_id"] == str(done_col.id)


# ---------------------------------------------------------------------------
# PAR-3a: parent_card_id schema field round-trip.
#
# parent_card_id is set by the conflict-consolidator path (PAR-3c) at the
# DB layer, never by API clients. This test seeds it directly and asserts
# the GET endpoint surfaces the value through CardRead.
# ---------------------------------------------------------------------------


async def test_card_parent_card_id_round_trip(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
    test_card: Card,
):
    consolidator = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Resolve merge conflict for Test Card",
        description="",
        position=2048.0,
        created_by=test_user.id,
        parent_card_id=test_card.id,
    )
    db_session.add(consolidator)
    await db_session.flush()

    parent_response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert parent_response.status_code == 200
    assert parent_response.json()["parent_card_id"] is None

    child_response = await client.get(_url(test_board, f"/{consolidator.id}"))
    assert child_response.status_code == 200
    assert child_response.json()["parent_card_id"] == str(test_card.id)


# ---------------------------------------------------------------------------
# Card titles are plain text, not markup. Nothing between the API boundary and
# the DB row may HTML-escape them: a title reading `He said &quot;ship it&quot;`
# is corruption, not safety. XSS defence belongs to the renderer (React escapes
# on output), so these tests pin the absence of escaping at every hop —
# request body, response body, and the persisted column itself.
# ---------------------------------------------------------------------------

MARKUP_TITLE = 'He said "ship it" & left <tag> — 5 < 6 > 4'


async def test_create_card_preserves_markup_characters_in_title(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": MARKUP_TITLE,
            "description": MARKUP_TITLE,
            "column_id": str(test_column.id),
        },
    )
    assert response.status_code == 201
    assert response.json()["title"] == MARKUP_TITLE
    # The description now normalizes to PM JSON; the markup characters must
    # survive UN-escaped inside the doc's text runs.
    description_doc = json.loads(response.json()["description"])
    description_text = "".join(
        run["text"] for run in description_doc["content"][0]["content"]
    )
    assert description_text == MARKUP_TITLE

    stored = await db_session.get(Card, uuid.UUID(response.json()["id"]))
    assert stored.title == MARKUP_TITLE
    assert "&quot;" not in stored.title
    assert "&amp;" not in stored.title
    assert "&lt;" not in stored.title


async def test_get_card_preserves_markup_characters_in_title(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title=MARKUP_TITLE,
        description="",
        position=4096.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{card.id}"))
    assert response.status_code == 200
    assert response.json()["title"] == MARKUP_TITLE


async def test_update_card_preserves_markup_characters_in_title(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"title": MARKUP_TITLE, "status": MARKUP_TITLE},
    )
    assert response.status_code == 200
    assert response.json()["title"] == MARKUP_TITLE
    assert response.json()["status"] == MARKUP_TITLE

    await db_session.refresh(test_card)
    assert test_card.title == MARKUP_TITLE


async def test_card_search_preserves_markup_characters_in_title(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title=MARKUP_TITLE,
        description="",
        position=8192.0,
        created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    searched = await client.get(_url(test_board, "/search"), params={"q": "ship it"})
    assert searched.status_code == 200
    assert MARKUP_TITLE in [c["title"] for c in searched.json()]


# The DB columns are Card.status String(255) and Card.title String(500); on
# Postgres an over-length value raises StringDataRightTruncation and escapes as
# a 500. SQLite (the test DB) does not enforce VARCHAR lengths, so these tests
# pin the Pydantic layer that must reject the value before it reaches the DB.
STATUS_MAX_LENGTH = 255
TITLE_MAX_LENGTH = 500

# A verbatim agent closure status from a field run (2026-08-09): a sha, a PR number
# and a Spanish clause. 100 chars could not hold it, which is why agents
# degraded to recording closure in description prose.
REALISTIC_CLOSURE_STATUS = (
    "shipped 639c5468 (PR #96, self-improve-3) — log de iteraciones completo "
    "con paginación, filtros por outcome y búsqueda; gates verdes, sin reds "
    "conocidos, merge sin conflictos"
)


def _detail_for(response, field: str) -> dict:
    return next(
        item for item in response.json()["detail"] if item["loc"][-1] == field
    )


async def test_create_card_rejects_over_length_status(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "Card",
            "column_id": str(test_column.id),
            "status": "x" * 300,
        },
    )
    assert response.status_code == 422
    detail = _detail_for(response, "status")
    assert detail["type"] == "string_too_long"
    assert detail["ctx"]["max_length"] == STATUS_MAX_LENGTH


async def test_update_card_rejects_over_length_status(
    client: AsyncClient,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": "x" * 300},
    )
    assert response.status_code == 422
    detail = _detail_for(response, "status")
    assert detail["type"] == "string_too_long"
    assert detail["ctx"]["max_length"] == STATUS_MAX_LENGTH


async def test_update_card_accepts_realistic_agent_closure_status(
    client: AsyncClient,
    test_board: Board,
    test_card: Card,
):
    assert 100 < len(REALISTIC_CLOSURE_STATUS) <= STATUS_MAX_LENGTH

    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": REALISTIC_CLOSURE_STATUS},
    )

    assert response.status_code == 200
    assert response.json()["status"] == REALISTIC_CLOSURE_STATUS


async def test_update_card_status_boundary_is_inclusive(
    client: AsyncClient,
    test_board: Board,
    test_card: Card,
):
    at_limit = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": "x" * STATUS_MAX_LENGTH},
    )
    assert at_limit.status_code == 200
    assert at_limit.json()["status"] == "x" * STATUS_MAX_LENGTH

    over_limit = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"status": "x" * (STATUS_MAX_LENGTH + 1)},
    )
    assert over_limit.status_code == 422


async def test_create_card_rejects_over_length_title(
    client: AsyncClient,
    test_board: Board,
    test_column: Column,
):
    response = await client.post(
        _url(test_board),
        json={
            "title": "t" * (TITLE_MAX_LENGTH + 1),
            "column_id": str(test_column.id),
        },
    )
    assert response.status_code == 422
    detail = _detail_for(response, "title")
    assert detail["type"] == "string_too_long"
    assert detail["ctx"]["max_length"] == TITLE_MAX_LENGTH


async def test_update_card_title_boundary_is_inclusive(
    client: AsyncClient,
    test_board: Board,
    test_card: Card,
):
    at_limit = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"title": "t" * TITLE_MAX_LENGTH},
    )
    assert at_limit.status_code == 200

    over_limit = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"title": "t" * (TITLE_MAX_LENGTH + 1)},
    )
    assert over_limit.status_code == 422
