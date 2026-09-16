# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Binding a git repo to a workspace credential.

Binding is privileged: it decides which token the merge queue will embed into
this repo's clone URL, so a plain member must not be able to point a repo at a
credential. Creating a repo WITHOUT a connection stays member-level.
"""

from __future__ import annotations

import os
import uuid

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.integrations.git.vault import FernetTokenVault
from app.main import create_app
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


@pytest_asyncio.fixture
async def connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> GitConnection:
    conn = GitConnection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="acme-bot",
        account_type="organization",
        encrypted_access_token=_vault().encrypt("ghp_token"),
        scopes=["repo"],
        auth_kind="pat",
        connected_by=test_user.id,
    )
    db_session.add(conn)
    await db_session.flush()
    return conn


@pytest_asyncio.fixture
async def gitlab_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> GitConnection:
    conn = GitConnection(
        workspace_id=test_workspace.id,
        provider=GitProvider.gitlab,
        account_login="gl-bot",
        account_type="user",
        encrypted_access_token=_vault().encrypt("glpat_token"),
        scopes=["api"],
        auth_kind="pat",
        base_url="https://gitlab.com",
        connected_by=test_user.id,
    )
    db_session.add(conn)
    await db_session.flush()
    return conn


async def _member_client(
    db_session: AsyncSession, workspace: Workspace
) -> AsyncClient:
    member = User(email="member@valaris.dev", name="Member")
    db_session.add(member)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=member.id, role=WorkspaceRole.member
        )
    )
    await db_session.flush()

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return member

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _repo_url(board: Board) -> str:
    return f"/api/workspaces/default/boards/{board.id}/git-repos"


# --- read surface ---


async def test_get_git_repo_exposes_connection_id(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    connection: GitConnection,
):
    repo = GitRepo(
        board_id=test_board.id,
        workspace_id=test_workspace.id,
        name="widgets",
        slug="widgets",
        url="https://github.com/acme/widgets.git",
        provider=GitProvider.github,
        default_branch="main",
        description="",
        added_by=test_user.id,
        connection_id=connection.id,
    )
    db_session.add(repo)
    await db_session.flush()

    response = await client.get(f"{_repo_url(test_board)}/widgets")

    assert response.status_code == 200
    assert response.json()["connection_id"] == str(connection.id)


async def test_get_git_repo_unbound_reports_null_connection(
    client: AsyncClient, test_board: Board, test_git_repo: GitRepo
):
    response = await client.get(f"{_repo_url(test_board)}/{test_git_repo.id}")

    assert response.status_code == 200
    assert response.json()["connection_id"] is None


# --- create with binding ---


async def test_create_git_repo_with_connection_as_admin(
    client: AsyncClient, test_board: Board, connection: GitConnection
):
    response = await client.post(
        _repo_url(test_board),
        json={
            "name": "widgets-admin-bind",
            "url": "https://github.com/acme/widgets.git",
            "provider": "github",
            "connection_id": str(connection.id),
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["connection_id"] == str(connection.id)


async def test_create_git_repo_with_connection_requires_admin(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    connection: GitConnection,
):
    client = await _member_client(db_session, test_workspace)
    async with client as ac:
        response = await ac.post(
            _repo_url(test_board),
            json={
                "name": "widgets-member-denied",
                "url": "https://github.com/acme/widgets.git",
                "provider": "github",
                "connection_id": str(connection.id),
            },
        )

    assert response.status_code == 403
    assert "admin" in response.text.lower()


async def test_create_git_repo_with_mismatched_provider_connection_is_422(
    client: AsyncClient, test_board: Board, gitlab_connection: GitConnection
):
    """Validation must run on create, not only on update.

    A repo created against a mismatched credential would otherwise persist a
    binding the resolver can never honour.
    """
    response = await client.post(
        _repo_url(test_board),
        json={
            "name": "widgets-provider-mismatch",
            "url": "https://github.com/acme/widgets.git",
            "provider": "github",
            "connection_id": str(gitlab_connection.id),
        },
    )

    assert response.status_code == 422
    body = response.text.lower()
    assert "gitlab" in body and "github" in body


async def test_create_git_repo_with_cross_workspace_connection_is_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    other = Workspace(name="Other", slug="other-ws", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    foreign = GitConnection(
        workspace_id=other.id,
        provider=GitProvider.github,
        account_login="foreign-bot",
        account_type="user",
        encrypted_access_token=_vault().encrypt("ghp_foreign"),
        scopes=[],
        connected_by=test_user.id,
    )
    db_session.add(foreign)
    await db_session.flush()

    response = await client.post(
        _repo_url(test_board),
        json={
            "name": "widgets-cross-workspace",
            "url": "https://github.com/acme/widgets.git",
            "provider": "github",
            "connection_id": str(foreign.id),
        },
    )

    assert response.status_code == 422
    assert "not found" in response.text.lower()


async def test_create_git_repo_persists_connection_binding(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    connection: GitConnection,
):
    """201 in the response body is not proof the FK actually landed."""
    response = await client.post(
        _repo_url(test_board),
        json={
            "name": "widgets-persisted",
            "url": "https://github.com/acme/widgets.git",
            "provider": "github",
            "connection_id": str(connection.id),
        },
    )

    assert response.status_code == 201, response.text
    stored = (
        await db_session.execute(
            select(GitRepo).where(GitRepo.id == uuid.UUID(response.json()["id"]))
        )
    ).scalar_one()
    assert stored.connection_id == connection.id


async def test_create_git_repo_without_connection_allows_member(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    client = await _member_client(db_session, test_workspace)
    async with client as ac:
        response = await ac.post(
            _repo_url(test_board),
            json={
                "name": "widgets-member-plain",
                "url": "https://github.com/acme/widgets.git",
                "provider": "github",
            },
        )

    assert response.status_code == 201, response.text
    assert response.json()["connection_id"] is None


# --- update / rebind ---


async def test_update_git_repo_binds_connection(
    client: AsyncClient, test_board: Board, test_git_repo: GitRepo, connection: GitConnection
):
    response = await client.put(
        f"{_repo_url(test_board)}/{test_git_repo.id}",
        json={"connection_id": str(connection.id)},
    )

    assert response.status_code == 200, response.text
    assert response.json()["connection_id"] == str(connection.id)


async def test_update_git_repo_clears_connection(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_git_repo: GitRepo,
    connection: GitConnection,
):
    test_git_repo.connection_id = connection.id
    await db_session.flush()

    response = await client.put(
        f"{_repo_url(test_board)}/{test_git_repo.id}",
        json={"connection_id": None},
    )

    assert response.status_code == 200, response.text
    assert response.json()["connection_id"] is None


async def test_update_git_repo_omitting_connection_id_leaves_binding_intact(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_git_repo: GitRepo,
    connection: GitConnection,
):
    """Omitted != null. A patch that doesn't mention connection_id must not unbind."""
    test_git_repo.connection_id = connection.id
    await db_session.flush()

    response = await client.put(
        f"{_repo_url(test_board)}/{test_git_repo.id}",
        json={"description": "unrelated edit"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["connection_id"] == str(connection.id)


async def test_update_git_repo_connection_requires_admin(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo: GitRepo,
    connection: GitConnection,
):
    client = await _member_client(db_session, test_workspace)
    async with client as ac:
        response = await ac.put(
            f"{_repo_url(test_board)}/{test_git_repo.id}",
            json={"connection_id": str(connection.id)},
        )

    assert response.status_code == 403


async def test_update_git_repo_non_connection_field_allows_member(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_git_repo: GitRepo,
):
    client = await _member_client(db_session, test_workspace)
    async with client as ac:
        response = await ac.put(
            f"{_repo_url(test_board)}/{test_git_repo.id}",
            json={"description": "still member-editable"},
        )

    assert response.status_code == 200, response.text


# --- validation ---


async def test_bind_nonexistent_connection_is_422(
    client: AsyncClient, test_board: Board, test_git_repo: GitRepo
):
    response = await client.put(
        f"{_repo_url(test_board)}/{test_git_repo.id}",
        json={"connection_id": str(uuid.uuid4())},
    )

    assert response.status_code == 422
    assert "not found" in response.text.lower()


async def test_bind_connection_from_other_workspace_is_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_git_repo: GitRepo,
    test_user: User,
):
    other = Workspace(name="Other", slug="other-ws", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    foreign = GitConnection(
        workspace_id=other.id,
        provider=GitProvider.github,
        account_login="foreign-bot",
        account_type="user",
        encrypted_access_token=_vault().encrypt("ghp_foreign"),
        scopes=[],
        connected_by=test_user.id,
    )
    db_session.add(foreign)
    await db_session.flush()

    response = await client.put(
        f"{_repo_url(test_board)}/{test_git_repo.id}",
        json={"connection_id": str(foreign.id)},
    )

    assert response.status_code == 422
    assert "not found" in response.text.lower()


async def test_bind_connection_with_mismatched_provider_is_422(
    client: AsyncClient,
    test_board: Board,
    test_git_repo: GitRepo,
    gitlab_connection: GitConnection,
):
    """test_git_repo is a github repo; a gitlab credential can never serve it."""
    response = await client.put(
        f"{_repo_url(test_board)}/{test_git_repo.id}",
        json={"connection_id": str(gitlab_connection.id)},
    )

    assert response.status_code == 422
    body = response.text.lower()
    assert "gitlab" in body and "github" in body
