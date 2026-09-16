# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""First-run setup endpoints (local-auth card 3).

An empty `users` table makes POST /api/auth/setup live; it self-closes the
instant any user exists (L2) and reopens only if the table empties again (L3).
The emptiness check must run inside the inserting transaction — two
overlapping setup requests must produce exactly one admin.
"""

from __future__ import annotations

import asyncio

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.core.password import MIN_PASSWORD_LENGTH, hash_password
from app.core.session_cookie import SESSION_COOKIE_NAME
from app.database import get_db
from app.main import create_app
from app.models.user import User
from app.services.auth.local_auth import LocalAuthService

SIGNING_KEY = "test-signing-key"
GOOD_PASSWORD = "correct horse battery staple"


@pytest_asyncio.fixture
async def setup_db(db_engine):
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session


@pytest.fixture(autouse=True)
def signing_key(monkeypatch):
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", SIGNING_KEY)


def _make_client(db: AsyncSession) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _user_count(db: AsyncSession) -> int:
    return (await db.execute(select(func.count()).select_from(User))).scalar_one()


# ── setup-status ──


@pytest.mark.asyncio
async def test_setup_status_true_on_empty_db(setup_db):
    async with _make_client(setup_db) as client:
        resp = await client.get("/api/auth/setup-status")
        assert resp.status_code == 200
        assert resp.json() == {"needs_setup": True}


@pytest.mark.asyncio
async def test_setup_status_false_once_user_exists(setup_db):
    setup_db.add(User(email="existing@example.com", name="Existing"))
    await setup_db.flush()
    async with _make_client(setup_db) as client:
        resp = await client.get("/api/auth/setup-status")
        assert resp.status_code == 200
        assert resp.json() == {"needs_setup": False}


# ── setup ──


@pytest.mark.asyncio
async def test_setup_creates_admin_sets_cookie(setup_db):
    async with _make_client(setup_db) as client:
        resp = await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": GOOD_PASSWORD},
        )
        assert resp.status_code == 201
        assert resp.json()["email"] == "admin@example.com"
        assert SESSION_COOKIE_NAME in resp.cookies

        set_cookie = resp.headers["set-cookie"]
        assert "HttpOnly" in set_cookie
        assert "Path=/" in set_cookie
        assert "SameSite=lax" in set_cookie.lower() or "samesite=lax" in set_cookie.lower()


@pytest.mark.asyncio
async def test_setup_cookie_not_secure_on_http_origin(setup_db, monkeypatch):
    """First-run setup on an http:// self-host must leave the admin logged in —
    a Secure cookie over plain http is silently dropped by the browser."""
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", True)
    monkeypatch.setattr(app_settings, "FRONTEND_URL", "http://192.168.1.50:8080")
    async with _make_client(setup_db) as client:
        resp = await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": GOOD_PASSWORD},
        )
        assert resp.status_code == 201
        assert "; secure" not in resp.headers["set-cookie"].lower()


@pytest.mark.asyncio
async def test_setup_created_admin_can_authenticate(setup_db):
    """The stored hash actually verifies — not just that a row appeared."""
    async with _make_client(setup_db) as client:
        await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": GOOD_PASSWORD},
        )
    user = await LocalAuthService(setup_db).authenticate(
        "admin@example.com", GOOD_PASSWORD
    )
    assert user is not None and user.email == "admin@example.com"


@pytest.mark.asyncio
async def test_setup_stores_normalized_email(setup_db):
    async with _make_client(setup_db) as client:
        resp = await client.post(
            "/api/auth/setup",
            json={"email": "  Admin@Example.COM ", "password": GOOD_PASSWORD},
        )
        assert resp.status_code == 201
        assert resp.json()["email"] == "admin@example.com"


@pytest.mark.asyncio
async def test_setup_second_time_404(setup_db):
    async with _make_client(setup_db) as client:
        first = await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": GOOD_PASSWORD},
        )
        assert first.status_code == 201
        second = await client.post(
            "/api/auth/setup",
            json={"email": "other@example.com", "password": GOOD_PASSWORD},
        )
        assert second.status_code == 404
    assert await _user_count(setup_db) == 1


@pytest.mark.asyncio
async def test_setup_with_preexisting_sso_user_404(setup_db):
    """An OIDC-provisioned instance (users without passwords) is NOT fresh."""
    setup_db.add(User(email="sso@example.com", name="Sso"))
    await setup_db.flush()
    async with _make_client(setup_db) as client:
        resp = await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": GOOD_PASSWORD},
        )
        assert resp.status_code == 404


@pytest.mark.asyncio
async def test_setup_password_below_minimum_length_422(setup_db):
    async with _make_client(setup_db) as client:
        resp = await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": "a" * (MIN_PASSWORD_LENGTH - 1)},
        )
        assert resp.status_code == 422
    assert await _user_count(setup_db) == 0


@pytest.mark.asyncio
async def test_setup_respects_allowed_email_domains(setup_db, monkeypatch):
    monkeypatch.setattr(app_settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "valaris.studio")
    async with _make_client(setup_db) as client:
        rejected = await client.post(
            "/api/auth/setup",
            json={"email": "admin@elsewhere.com", "password": GOOD_PASSWORD},
        )
        assert rejected.status_code == 403
        allowed = await client.post(
            "/api/auth/setup",
            json={"email": "admin@valaris.studio", "password": GOOD_PASSWORD},
        )
        assert allowed.status_code == 201


@pytest.mark.asyncio
async def test_setup_response_never_contains_password_hash(setup_db):
    async with _make_client(setup_db) as client:
        resp = await client.post(
            "/api/auth/setup",
            json={"email": "admin@example.com", "password": GOOD_PASSWORD},
        )
        assert "password" not in resp.text
        openapi = await client.get("/api/openapi.json")
        assert "password_hash" not in openapi.text


# ── concurrency / TOCTOU ──


@pytest.mark.asyncio
async def test_setup_emptiness_check_sees_uncommitted_insert(setup_db):
    """The check runs inside the inserting transaction: a second attempt in the
    same (uncommitted) transaction must already see the first admin."""
    service = LocalAuthService(setup_db)
    first = await service.create_first_admin("admin@example.com", GOOD_PASSWORD)
    assert first is not None
    second = await service.create_first_admin("other@example.com", GOOD_PASSWORD)
    assert second is None
    assert await _user_count(setup_db) == 1


@pytest.mark.asyncio
async def test_setup_conditional_insert_is_atomic(setup_db):
    """Even if a stale pre-check said 'empty', the INSERT itself must refuse
    once a user exists — the guard lives in the statement, not before it."""
    setup_db.add(
        User(
            email="raced@example.com",
            name="Raced",
            password_hash=hash_password(GOOD_PASSWORD),
        )
    )
    await setup_db.flush()
    created = await LocalAuthService(setup_db)._insert_first_admin(
        "admin@example.com", GOOD_PASSWORD
    )
    assert created is None
    assert await _user_count(setup_db) == 1


@pytest.mark.asyncio
async def test_setup_overlapping_requests_create_exactly_one_user(setup_db):
    """Double-submit of the first-run form: exactly one admin, one 201."""
    async with _make_client(setup_db) as client:
        payload = {"email": "admin@example.com", "password": GOOD_PASSWORD}
        first, second = await asyncio.gather(
            client.post("/api/auth/setup", json=payload),
            client.post("/api/auth/setup", json=payload),
        )
    statuses = sorted([first.status_code, second.status_code])
    assert statuses == [201, 404]
    assert await _user_count(setup_db) == 1
