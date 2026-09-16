# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B3: the OIDC session cookie as an auth tier in all three consumers.

Precedence (B-D6): API key > dev > session cookie > IAP > trusted proxy.
The cookie is the cheapest verified credential, so it outranks IAP/proxy; the
API key stays on top so runners and MCP are never affected by a stray cookie.

Unlike the other tiers, the session tier never auto-provisions: the user row was
created at the OIDC callback, so a cookie naming a deleted user is a rejection.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.core.rate_limit import (
    AUTHENTICATED_LIMIT,
    UNAUTHENTICATED_LIMIT,
    RateLimitMiddleware,
)
from app.core.session_cookie import SESSION_COOKIE_NAME, write_session
from app.database import get_db
from app.main import create_app
from app.models.user import User

SIGNING_KEY = "session-tier-signing-key"
PROXY_EMAIL_HEADER = "X-Goog-Authenticated-User-Email"


@pytest_asyncio.fixture
async def auth_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


@pytest_asyncio.fixture
async def session_user(auth_db) -> User:
    user = User(email="alice@valaris.studio", name="Alice")
    auth_db.add(user)
    await auth_db.flush()
    return user


@pytest.fixture
def oidc_tier(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_SECRET", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH_HEADER", PROXY_EMAIL_HEADER)
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
    monkeypatch.setattr(app_settings, "OIDC_CLIENT_ID", "backplane")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", SIGNING_KEY)
    monkeypatch.setattr(app_settings, "OIDC_SESSION_TTL_SECONDS", 43200)
    monkeypatch.setattr(app_settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "")
    monkeypatch.setattr(app_settings, "AUTH_AUTO_PROVISION", True)


def _make_client(auth_db: AsyncSession):
    app = create_app()

    async def override_get_db():
        yield auth_db

    app.dependency_overrides[get_db] = override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _cookie_for(user_id: uuid.UUID) -> dict[str, str]:
    return {SESSION_COOKIE_NAME: write_session(user_id, signing_key=SIGNING_KEY)}


def _fake_ws(headers: dict[str, str], cookies: dict[str, str] | None = None):
    return SimpleNamespace(headers=headers, query_params={}, cookies=cookies or {})


# ── HTTP consumer ──


@pytest.mark.asyncio
async def test_valid_session_cookie_authenticates(oidc_tier, auth_db, session_user):
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/workspaces", cookies=_cookie_for(session_user.id))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_tampered_session_cookie_is_rejected(oidc_tier, auth_db, session_user):
    raw = write_session(session_user.id, signing_key=SIGNING_KEY)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", cookies={SESSION_COOKIE_NAME: raw[:-4] + "AAAA"}
        )
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_invalid"


@pytest.mark.asyncio
async def test_session_cookie_signed_with_another_key_is_rejected(
    oidc_tier, auth_db, session_user
):
    forged = write_session(session_user.id, signing_key="attacker-key")
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", cookies={SESSION_COOKIE_NAME: forged}
        )
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_invalid"


@pytest.mark.asyncio
async def test_expired_session_cookie_is_rejected(
    oidc_tier, auth_db, session_user, monkeypatch
):
    monkeypatch.setattr(app_settings, "OIDC_SESSION_TTL_SECONDS", -1)
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/workspaces", cookies=_cookie_for(session_user.id))
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_invalid"


@pytest.mark.asyncio
async def test_session_for_deleted_user_is_rejected_not_reprovisioned(
    oidc_tier, auth_db
):
    """The session tier never creates users — provisioning happened at callback."""
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/workspaces", cookies=_cookie_for(uuid.uuid4()))
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "session_user_not_found"


@pytest.mark.asyncio
async def test_session_rejection_is_audit_logged(oidc_tier, auth_db, caplog):
    import logging

    with caplog.at_level(logging.WARNING, logger="app.core.auth"):
        async with _make_client(auth_db) as client:
            await client.get("/api/workspaces", cookies=_cookie_for(uuid.uuid4()))
    assert "session_user_not_found" in caplog.text


@pytest.mark.asyncio
async def test_no_cookie_with_only_oidc_configured_is_rejected(oidc_tier, auth_db):
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/workspaces")
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "authentication_required"


# ── precedence (B-D6) ──


@pytest.mark.asyncio
async def test_session_cookie_beats_iap(oidc_tier, auth_db, session_user, monkeypatch):
    """A valid cookie short-circuits IAP — no JWT verification is attempted."""
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces",
            cookies=_cookie_for(session_user.id),
            headers={"X-Goog-IAP-JWT-Assertion": "not-a-real-jwt"},
        )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_session_cookie_beats_trusted_proxy(
    oidc_tier, auth_db, session_user, monkeypatch
):
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", True)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/me",
            cookies=_cookie_for(session_user.id),
            headers={PROXY_EMAIL_HEADER: "someone.else@valaris.studio"},
        )
    assert resp.status_code == 200
    assert resp.json()["email"] == "alice@valaris.studio"


@pytest.mark.asyncio
async def test_api_key_beats_session_cookie(oidc_tier, auth_db, session_user):
    """Runners/MCP must be unaffected by a browser cookie riding along."""
    from app.services.api_key import ApiKeyService

    other = User(email="runner@valaris.studio", name="Runner")
    auth_db.add(other)
    await auth_db.flush()
    _, raw_key = await ApiKeyService(auth_db).create_key(other.id, "runner-key")

    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/me",
            cookies=_cookie_for(session_user.id),
            headers={"Authorization": f"Bearer {raw_key}"},
        )
    assert resp.status_code == 200
    assert resp.json()["email"] == "runner@valaris.studio"


@pytest.mark.asyncio
async def test_invalid_cookie_does_not_fall_through_to_a_weaker_tier(
    oidc_tier, auth_db, monkeypatch
):
    """A bad cookie is a rejection, never a silent downgrade to header trust."""
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", True)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces",
            cookies={SESSION_COOKIE_NAME: "garbage"},
            headers={PROXY_EMAIL_HEADER: "attacker@valaris.studio"},
        )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_dev_mode_still_wins_over_session(auth_db, session_user, monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", SIGNING_KEY)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/me",
            cookies=_cookie_for(session_user.id),
            headers={"X-User-Email": "dev-person@valaris.dev"},
        )
    assert resp.status_code == 200
    assert resp.json()["email"] == "dev-person@valaris.dev"


# ── WebSocket consumer ──


@pytest_asyncio.fixture
async def ws_session_factory(db_engine, monkeypatch):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    import app.routers.events as events_module

    monkeypatch.setattr(events_module, "async_session", factory)
    return factory


@pytest.mark.asyncio
async def test_ws_accepts_session_cookie(oidc_tier, ws_session_factory, session_user):
    from app.routers.events import _authenticate_ws

    user, _ = await _authenticate_ws(_fake_ws({}, cookies=_cookie_for(session_user.id)))
    assert user is not None and user.email == "alice@valaris.studio"


@pytest.mark.asyncio
async def test_ws_rejects_tampered_session_cookie(oidc_tier, ws_session_factory):
    from app.routers.events import _authenticate_ws

    user, _ = await _authenticate_ws(_fake_ws({}, cookies={SESSION_COOKIE_NAME: "bad"}))
    assert user is None


@pytest.mark.asyncio
async def test_ws_rejects_session_for_deleted_user(oidc_tier, ws_session_factory):
    from app.routers.events import _authenticate_ws

    user, _ = await _authenticate_ws(_fake_ws({}, cookies=_cookie_for(uuid.uuid4())))
    assert user is None


# ── rate limiter consumer ──


def test_rate_limiter_gives_session_the_authed_tier(oidc_tier, session_user):
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)
    key, limit = limiter._get_client_key(
        SimpleNamespace(
            headers={},
            cookies=_cookie_for(session_user.id),
            client=SimpleNamespace(host="10.0.0.9"),
            method="GET",
            url=SimpleNamespace(path="/api/health"),
        )
    )
    assert key == f"user:{session_user.id}"
    assert limit == AUTHENTICATED_LIMIT


def test_rate_limiter_keeps_ip_tier_for_a_bad_session(oidc_tier):
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)
    key, limit = limiter._get_client_key(
        SimpleNamespace(
            headers={},
            cookies={SESSION_COOKIE_NAME: "garbage"},
            client=SimpleNamespace(host="10.0.0.9"),
            method="GET",
            url=SimpleNamespace(path="/api/health"),
        )
    )
    assert key.startswith("ip:") and limit == UNAUTHENTICATED_LIMIT


@pytest.mark.asyncio
async def test_valid_session_workspace_permission_failure_is_not_authentication_failure(
    oidc_tier, auth_db, session_user, test_workspace
):
    async with _make_client(auth_db) as client:
        resp = await client.get(
            f"/api/workspaces/{test_workspace.slug}/resources",
            cookies=_cookie_for(session_user.id),
        )
    assert resp.status_code == 403
    assert resp.json()["error_code"] == "forbidden"
