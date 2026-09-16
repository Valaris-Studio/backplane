# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace-scoped git connection CRUD + repo picker router tests.

The picker endpoint instantiates a GitHubAdapter; we override the underlying
httpx transport for that request via FastAPI's dependency_overrides on the
adapter factory built into the router.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.integrations.git.adapters.github import GitHubAdapter
from app.integrations.git.vault import FernetTokenVault
from app.main import create_app
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.routers.integrations import git_connections as git_connections_router


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


@pytest_asyncio.fixture
async def github_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> GitConnection:
    conn = GitConnection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        encrypted_access_token=_vault().encrypt("ghp_token123"),
        scopes=["repo"],
        connected_by=test_user.id,
    )
    db_session.add(conn)
    await db_session.flush()
    return conn


# --- list ---


async def test_list_git_connections_returns_workspace_connections(
    client: AsyncClient, test_workspace: Workspace, github_connection: GitConnection
):
    response = await client.get("/api/workspaces/default/git-connections")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["account_login"] == "octocat"
    assert data[0]["provider"] == "github"
    # Tokens MUST NOT be in the response.
    assert "access_token" not in data[0]
    assert "encrypted_access_token" not in data[0]


async def test_list_git_connections_excludes_other_workspace(
    db_session: AsyncSession,
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    github_connection: GitConnection,
):
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner)
    )
    db_session.add(
        GitConnection(
            workspace_id=other.id,
            provider=GitProvider.github,
            account_login="other-acc",
            account_type="user",
            encrypted_access_token=_vault().encrypt("zzz"),
            scopes=["repo"],
            connected_by=test_user.id,
        )
    )
    await db_session.flush()

    response = await client.get("/api/workspaces/default/git-connections")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["account_login"] == "octocat"


# --- delete ---


async def test_delete_git_connection_requires_admin(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    github_connection: GitConnection,
):
    member = User(email="member@valaris.dev", name="Member")
    db_session.add(member)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=member.id,
            role=WorkspaceRole.member,
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
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        response = await ac.delete(
            f"/api/workspaces/default/git-connections/{github_connection.id}"
        )
    assert response.status_code == 403


async def test_delete_git_connection_admin_succeeds(
    client: AsyncClient,
    test_workspace: Workspace,
    github_connection: GitConnection,
):
    response = await client.delete(
        f"/api/workspaces/default/git-connections/{github_connection.id}"
    )
    assert response.status_code == 204


# --- repositories picker ---


async def test_list_repositories_via_connection_returns_paginated_response(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    github_connection: GitConnection,
):
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    # Override the adapter factory so picker uses a MockTransport.
    def handler(request):
        return httpx.Response(
            200,
            content=json.dumps(
                [
                    {
                        "id": 1,
                        "full_name": "acme/widgets",
                        "name": "widgets",
                        "private": False,
                        "default_branch": "main",
                        "clone_url": "https://github.com/acme/widgets.git",
                        "updated_at": "2026-01-01T00:00:00Z",
                        "owner": {"login": "acme", "type": "Organization"},
                    }
                ]
            ).encode(),
            headers={
                "content-type": "application/json",
                "Link": '<https://api.github.com/user/repos?page=2>; rel="next"',
            },
        )

    transport = httpx.MockTransport(handler)

    def fake_build_adapter(provider, access_token, base_url):
        return GitHubAdapter(access_token=access_token, async_transport=transport)

    git_connections_router._build_adapter = fake_build_adapter
    try:
        asgi = ASGITransport(app=app)
        async with AsyncClient(transport=asgi, base_url="http://test") as ac:
            response = await ac.get(
                f"/api/workspaces/default/git-connections/{github_connection.id}/repositories"
            )
    finally:
        # restore module attribute so other tests aren't affected
        import importlib

        importlib.reload(git_connections_router)

    assert response.status_code == 200
    data = response.json()
    assert "items" in data and "next_cursor" in data
    assert len(data["items"]) == 1
    assert data["items"][0]["full_name"] == "acme/widgets"
    assert data["items"][0]["clone_url_https"] == "https://github.com/acme/widgets.git"
    assert data["next_cursor"] == "2"
    # provider_data must NOT leak into the API surface
    assert "provider_data" not in data["items"][0]
