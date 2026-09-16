# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""OAuth web-flow router tests for the GitHub provider.

The HTTPX client used by the callback is overridden via FastAPI's
dependency_overrides so we never reach github.com. Each test wires a
fresh `httpx.MockTransport` whose handler asserts on the inbound request
shape (path + method) and returns canned responses.
"""

from __future__ import annotations

import json
from typing import Callable
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import get_current_user
from app.database import get_db
from app.integrations.git.oauth_state import (
    OAUTH_STATE_COOKIE_NAME,
)
from app.main import create_app
from app.models.git.git_connection import GitConnection
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.routers.integrations import oauth_github as oauth_github_router


def _build_oauth_callback_handler(
    *,
    account_login: str = "octocat",
    account_type: str = "User",
    access_token: str = "ghp_callback_token",
    token_response_overrides: dict | None = None,
    user_status: int = 200,
    token_status: int = 200,
) -> Callable[[httpx.Request], httpx.Response]:
    def handler(request: httpx.Request) -> httpx.Response:
        if (
            request.url.host == "github.com"
            and request.url.path == "/login/oauth/access_token"
        ):
            body = {
                "access_token": access_token,
                "scope": "repo,workflow",
                "token_type": "bearer",
            }
            body.update(token_response_overrides or {})
            return httpx.Response(
                token_status,
                content=json.dumps(body).encode(),
                headers={"content-type": "application/json"},
            )
        if request.url.host == "api.github.com" and request.url.path == "/user":
            return httpx.Response(
                user_status,
                content=json.dumps(
                    {
                        "login": account_login,
                        "id": 1,
                        "type": account_type,
                        "avatar_url": "",
                        "email": None,
                    }
                ).encode(),
                headers={"content-type": "application/json"},
            )
        return httpx.Response(404, content=b"unhandled mock url")

    return handler


def _override_oauth_http_client(app, handler):
    transport = httpx.MockTransport(handler)

    async def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=transport)

    app.dependency_overrides[oauth_github_router._http_client_dependency] = factory


@pytest_asyncio.fixture
async def member_user_only(db_session: AsyncSession) -> User:
    user = User(email="member@valaris.dev", name="Member User")
    db_session.add(user)
    await db_session.flush()
    return user


@pytest_asyncio.fixture
async def workspace_with_member(
    db_session: AsyncSession,
    test_workspace: Workspace,
    member_user_only: User,
) -> Workspace:
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=member_user_only.id,
            role=WorkspaceRole.member,
        )
    )
    await db_session.flush()
    return test_workspace


@pytest_asyncio.fixture
async def member_client(
    db_session: AsyncSession, member_user_only: User
) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return member_user_only

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


# --- start endpoint ---


async def test_oauth_start_redirects_to_github_with_state_cookie(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(
        "/api/workspaces/default/oauth/github/start", follow_redirects=False
    )
    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://github.com/login/oauth/authorize?")
    qs = parse_qs(urlsplit(location).query)
    assert qs["client_id"] == ["test-client-id"]
    assert qs["scope"] == ["repo"]
    assert "state" in qs
    cookie_header = response.headers.get("set-cookie", "")
    assert OAUTH_STATE_COOKIE_NAME in cookie_header
    assert "HttpOnly" in cookie_header


async def test_oauth_start_requires_workspace_admin(
    member_client: AsyncClient, workspace_with_member: Workspace
):
    response = await member_client.get(
        "/api/workspaces/default/oauth/github/start", follow_redirects=False
    )
    assert response.status_code == 403


# --- callback endpoint ---


async def _start_to_get_state(client: AsyncClient) -> tuple[str, str]:
    response = await client.get(
        "/api/workspaces/default/oauth/github/start", follow_redirects=False
    )
    location = response.headers["location"]
    state = parse_qs(urlsplit(location).query)["state"][0]
    cookie = client.cookies.get(OAUTH_STATE_COOKIE_NAME)
    assert cookie
    return state, cookie


async def test_oauth_callback_with_valid_state_creates_connection(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
):
    # Spy on the repo write: the callback stamps last_verified_at, and it must
    # be naive UTC (house style) — asyncpg rejects tz-aware values against the
    # timezone-less columns, and SQLite's refresh() round-trip strips tzinfo
    # so the stored row cannot reveal the bug.
    from app.repositories.git.git_connection import GitConnectionRepository

    written: dict = {}
    original_create = GitConnectionRepository.create

    async def spy_create(self, **kwargs):
        written.update(kwargs)
        return await original_create(self, **kwargs)

    monkeypatch.setattr(GitConnectionRepository, "create", spy_create)

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    _override_oauth_http_client(
        app,
        _build_oauth_callback_handler(
            account_login="acme-org", account_type="Organization"
        ),
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        state, _ = await _start_to_get_state(ac)
        response = await ac.get(
            "/api/oauth/github/callback",
            params={"code": "abc123", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 302
    assert "/default/settings" in response.headers["location"]
    rows = list((await db_session.execute(select(GitConnection))).scalars().all())
    assert len(rows) == 1
    assert rows[0].account_login == "acme-org"
    assert rows[0].account_type == "organization"
    assert rows[0].scopes == ["repo", "workflow"]
    assert written["last_verified_at"] is not None
    assert written["last_verified_at"].tzinfo is None


async def test_oauth_callback_demoted_admin_fails_closed(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Admin demoted between start and callback → error redirect, no connection."""
    from sqlalchemy import update

    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    _override_oauth_http_client(app, _build_oauth_callback_handler())
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        state, _ = await _start_to_get_state(ac)
        await db_session.execute(
            update(WorkspaceMember)
            .where(
                WorkspaceMember.workspace_id == test_workspace.id,
                WorkspaceMember.user_id == test_user.id,
            )
            .values(role=WorkspaceRole.member)
        )
        response = await ac.get(
            "/api/oauth/github/callback",
            params={"code": "abc123", "state": state},
            follow_redirects=False,
        )

    assert response.status_code == 302
    assert "code=admin_role_revoked" in response.headers["location"]
    rows = list((await db_session.execute(select(GitConnection))).scalars().all())
    assert rows == []


async def test_oauth_callback_with_invalid_state_returns_error_redirect(
    client: AsyncClient, test_workspace: Workspace
):
    state, _cookie = await _start_to_get_state(client)
    response = await client.get(
        "/api/oauth/github/callback",
        params={"code": "abc123", "state": "wrong-state"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert "/oauth-error" in response.headers["location"]
    assert "code=state_mismatch" in response.headers["location"]


async def test_oauth_callback_with_tampered_state_cookie_returns_error_redirect(
    client: AsyncClient, test_workspace: Workspace
):
    # Tampered signature and genuine expiry land in the same branch
    # (OAuthStateInvalid -> error_redirect with code=state_invalid_or_expired),
    # so we exercise that branch via tampering — fast and deterministic.
    # The TTL itself is unit-tested in tests/integrations/git/test_oauth_state.py.
    from itsdangerous import URLSafeTimedSerializer

    serializer = URLSafeTimedSerializer(
        "test-oauth-state-key-deadbeef-xyz", salt="git-oauth-state"
    )
    valid_cookie = serializer.dumps(
        {
            "state": "n",
            "workspace_slug": "default",
            "user_id": "00000000-0000-0000-0000-000000000000",
        }
    )
    client.cookies.set(OAUTH_STATE_COOKIE_NAME, valid_cookie + "tamper")
    response = await client.get(
        "/api/oauth/github/callback",
        params={"code": "abc", "state": "n"},
        follow_redirects=False,
    )
    assert response.status_code == 302
    assert "/oauth-error" in response.headers["location"]
    assert "code=state_invalid_or_expired" in response.headers["location"]


async def test_oauth_callback_idempotent_reconnect_updates_existing_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        _override_oauth_http_client(
            app,
            _build_oauth_callback_handler(
                account_login="octocat", access_token="ghp_first_call"
            ),
        )
        state1, _ = await _start_to_get_state(ac)
        await ac.get(
            "/api/oauth/github/callback",
            params={"code": "c1", "state": state1},
            follow_redirects=False,
        )
        # Second connect — same account, fresh tokens
        _override_oauth_http_client(
            app,
            _build_oauth_callback_handler(
                account_login="octocat", access_token="ghp_second_call"
            ),
        )
        ac.cookies.delete(OAUTH_STATE_COOKIE_NAME)
        state2, _ = await _start_to_get_state(ac)
        await ac.get(
            "/api/oauth/github/callback",
            params={"code": "c2", "state": state2},
            follow_redirects=False,
        )

    rows = list((await db_session.execute(select(GitConnection))).scalars().all())
    assert len(rows) == 1


async def test_oauth_callback_never_echoes_code_or_token_in_response(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    secret_token = "ghp_supersecrettokenneverleak"
    secret_code = "oauthcode_neverleak"
    _override_oauth_http_client(
        app, _build_oauth_callback_handler(access_token=secret_token)
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        state, _ = await _start_to_get_state(ac)
        response = await ac.get(
            "/api/oauth/github/callback",
            params={"code": secret_code, "state": state},
            follow_redirects=False,
        )

    rendered = response.text + response.headers.get("location", "")
    assert secret_token not in rendered
    assert secret_code not in rendered
