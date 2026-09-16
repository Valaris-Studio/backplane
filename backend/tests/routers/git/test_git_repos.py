# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


VALID_GIT_REPO = {
    "name": "valaris-api",
    "url": "https://github.com/valaris/api",
    "provider": "github",
    "default_branch": "main",
    "description": "Main API repo",
}


def base_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/git-repos"


async def test_list_git_repos_empty(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(base_url(test_board.id))
    assert response.status_code == 200
    assert response.json() == []


async def test_list_git_repos_with_data(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.get(base_url(test_board.id))
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["name"] == "Test Repo"
    assert data[0]["url"] == "https://github.com/valaris/test-repo"
    assert data[0]["provider"] == "github"


async def test_create_git_repo_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(base_url(test_board.id), json=VALID_GIT_REPO)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "valaris-api"
    assert data["url"] == "https://github.com/valaris/api"
    assert data["provider"] == "github"
    assert data["default_branch"] == "main"
    assert data["description"] == "Main API repo"
    assert "id" in data
    assert "created_at" in data


async def test_create_git_repo_missing_name(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    payload = {
        "url": "https://github.com/valaris/api",
        "provider": "github",
    }
    response = await client.post(base_url(test_board.id), json=payload)
    assert response.status_code == 422


async def test_get_git_repo_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.get(f"{base_url(test_board.id)}/{test_git_repo.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_git_repo.id)
    assert data["name"] == "Test Repo"


async def test_get_git_repo_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    fake_id = uuid.uuid4()
    response = await client.get(f"{base_url(test_board.id)}/{fake_id}")
    assert response.status_code == 404


async def test_update_git_repo_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.put(
        f"{base_url(test_board.id)}/{test_git_repo.id}",
        json={"name": "Updated Repo", "url": "https://github.com/valaris/updated"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Updated Repo"
    assert data["url"] == "https://github.com/valaris/updated"
    assert data["provider"] == "github"


async def test_update_git_repo_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    fake_id = uuid.uuid4()
    response = await client.put(
        f"{base_url(test_board.id)}/{fake_id}",
        json={"name": "Nope"},
    )
    assert response.status_code == 404


async def test_delete_git_repo_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.delete(f"{base_url(test_board.id)}/{test_git_repo.id}")
    assert response.status_code == 204

    get_resp = await client.get(f"{base_url(test_board.id)}/{test_git_repo.id}")
    assert get_resp.status_code == 404


async def test_delete_git_repo_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    fake_id = uuid.uuid4()
    response = await client.delete(f"{base_url(test_board.id)}/{fake_id}")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Slug support (UUID -> slug portability, T2.3a)
# ---------------------------------------------------------------------------


async def test_git_repo_read_includes_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.get(f"{base_url(test_board.id)}/{test_git_repo.id}")
    assert response.status_code == 200
    data = response.json()
    assert "slug" in data
    assert data["slug"]
    assert data["slug"] == "test-repo"


async def test_create_git_repo_auto_generates_slug_from_name(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "Valaris API Gateway"},
    )
    assert response.status_code == 201
    assert response.json()["slug"] == "valaris-api-gateway"


async def test_create_git_repo_disambiguates_duplicate_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "api", "url": "https://github.com/valaris/api-1"},
    )
    second = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "api", "url": "https://github.com/valaris/api-2"},
    )
    third = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "api", "url": "https://github.com/valaris/api-3"},
    )
    assert first.status_code == 201
    assert second.status_code == 201
    assert third.status_code == 201
    assert first.json()["slug"] == "api"
    assert second.json()["slug"] == "api-2"
    assert third.json()["slug"] == "api-3"


async def test_create_git_repo_same_slug_different_board_succeeds(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Other Board",
        description="",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()

    first = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "shared", "url": "https://github.com/a/shared"},
    )
    second = await client.post(
        base_url(other_board.id),
        json={**VALID_GIT_REPO, "name": "shared", "url": "https://github.com/b/shared"},
    )
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["slug"] == "shared"
    assert second.json()["slug"] == "shared"


async def test_create_git_repo_accepts_user_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "slug": "custom-slug"},
    )
    assert response.status_code == 201
    assert response.json()["slug"] == "custom-slug"


async def test_create_git_repo_rejects_invalid_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "slug": "Bad Slug!"},
    )
    assert response.status_code == 422


async def test_create_git_repo_duplicate_user_slug_returns_existing(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    first = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "slug": "same-slug", "url": "https://github.com/a/one"},
    )
    assert first.status_code == 201
    first_id = first.json()["id"]

    second = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "slug": "same-slug", "url": "https://github.com/a/two"},
    )
    # Idempotent: returns existing repo with original data.
    assert second.status_code in (200, 201)
    assert second.json()["id"] == first_id
    assert second.json()["url"] == "https://github.com/a/one"


async def test_get_git_repo_by_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.get(f"{base_url(test_board.id)}/test-repo")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_git_repo.id)
    assert data["slug"] == "test-repo"


async def test_get_git_repo_by_uuid_still_works(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.get(f"{base_url(test_board.id)}/{test_git_repo.id}")
    assert response.status_code == 200
    assert response.json()["id"] == str(test_git_repo.id)


async def test_update_git_repo_slug_conflict_returns_409(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    a = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "alpha", "url": "https://github.com/x/alpha"},
    )
    b = await client.post(
        base_url(test_board.id),
        json={**VALID_GIT_REPO, "name": "beta", "url": "https://github.com/x/beta"},
    )
    assert a.status_code == 201
    assert b.status_code == 201

    response = await client.put(
        f"{base_url(test_board.id)}/{b.json()['id']}",
        json={"slug": "alpha"},
    )
    assert response.status_code == 409


# ---------------------------------------------------------------------------
# PAR-1: integration_branch column on GitRepo (parallel-runner staging ground).
# ---------------------------------------------------------------------------


async def test_create_git_repo_defaults_integration_branch_null(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(base_url(test_board.id), json=VALID_GIT_REPO)
    assert response.status_code == 201
    data = response.json()
    assert "integration_branch" in data
    assert data["integration_branch"] is None


async def test_update_git_repo_sets_integration_branch(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    response = await client.put(
        f"{base_url(test_board.id)}/{test_git_repo.id}",
        json={"integration_branch": "develop"},
    )
    assert response.status_code == 200
    assert response.json()["integration_branch"] == "develop"


async def test_update_git_repo_clears_integration_branch(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    set_resp = await client.put(
        f"{base_url(test_board.id)}/{test_git_repo.id}",
        json={"integration_branch": "develop"},
    )
    assert set_resp.status_code == 200
    assert set_resp.json()["integration_branch"] == "develop"

    clear_resp = await client.put(
        f"{base_url(test_board.id)}/{test_git_repo.id}",
        json={"integration_branch": None},
    )
    assert clear_resp.status_code == 200
    assert clear_resp.json()["integration_branch"] is None
