# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""POST /auth/change-password (local-auth card 8).

Requires the CURRENT password — a stolen session must not be enough to take
over the account — and its failures feed the same lockout counters as login,
or the endpoint would be a lockout-free oracle for guessing the current
password from a hijacked session.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.core.password import hash_password
from app.database import get_db
from app.main import create_app
from app.models.user import User
from app.services.auth.local_auth import MAX_FAILED_LOGIN_ATTEMPTS

SIGNING_KEY = "change-password-test-key"
OLD_PASSWORD = "correct horse battery staple"
NEW_PASSWORD = "brand new sturdy passphrase"


@pytest_asyncio.fixture
async def login_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


@pytest.fixture(autouse=True)
def local_auth_only_production(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "")
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", True)
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", SIGNING_KEY)


@pytest_asyncio.fixture
async def password_user(login_db) -> User:
    user = User(
        email="pat@example.com",
        name="Pat",
        password_hash=hash_password(OLD_PASSWORD),
    )
    login_db.add(user)
    await login_db.flush()
    return user


def _make_client(db: AsyncSession) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db

    app.dependency_overrides[get_db] = override_get_db
    # https so the cookie jar honors the Secure flag set under ENV=production.
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://test")


async def _login(client: AsyncClient, password: str = OLD_PASSWORD):
    return await client.post(
        "/api/auth/login", json={"email": "pat@example.com", "password": password}
    )


async def _reload_user(db: AsyncSession, user_id) -> User:
    return (
        await db.execute(
            select(User)
            .where(User.id == user_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


@pytest.mark.asyncio
async def test_change_password_success_old_stops_new_works(login_db, password_user):
    async with _make_client(login_db) as client:
        assert (await _login(client)).status_code == 200
        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 204

        assert (await _login(client, OLD_PASSWORD)).status_code == 401
        assert (await _login(client, NEW_PASSWORD)).status_code == 200


@pytest.mark.asyncio
async def test_change_password_wrong_current_fails(login_db, password_user):
    async with _make_client(login_db) as client:
        assert (await _login(client)).status_code == 200
        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": "not my password", "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 400
        assert resp.json()["error_code"] == "current_password_incorrect"

        assert (await _login(client, OLD_PASSWORD)).status_code == 200


@pytest.mark.asyncio
async def test_change_password_requires_authentication(login_db, password_user):
    async with _make_client(login_db) as client:
        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 403


@pytest.mark.asyncio
async def test_change_password_clears_lockout_counter(login_db, password_user):
    async with _make_client(login_db) as client:
        for _ in range(MAX_FAILED_LOGIN_ATTEMPTS - 2):
            assert (await _login(client, "wrong guess")).status_code == 401
        assert (await _login(client)).status_code == 200

        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 204

    user = await _reload_user(login_db, password_user.id)
    assert user.failed_login_attempts == 0
    assert user.locked_until is None


@pytest.mark.asyncio
async def test_change_password_failures_feed_lockout(login_db, password_user):
    """A stolen session must not allow unthrottled guessing of the current
    password: change-password failures count toward the same lockout."""
    async with _make_client(login_db) as client:
        assert (await _login(client)).status_code == 200
        for _ in range(MAX_FAILED_LOGIN_ATTEMPTS):
            resp = await client.post(
                "/api/auth/change-password",
                json={"current_password": "guess", "new_password": NEW_PASSWORD},
            )
            assert resp.status_code == 400

        # Locked now: even the CORRECT current password is refused...
        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 400
        # ...and so is a fresh login with the correct password.
        assert (await _login(client, OLD_PASSWORD)).status_code == 401


@pytest.mark.asyncio
async def test_change_password_no_local_credential_fails(login_db):
    """An OIDC/IAP-provisioned user has no current password to prove."""
    sso_user = User(email="sso@example.com", name="Sso")
    login_db.add(sso_user)
    await login_db.flush()

    app = create_app()

    async def override_get_db():
        yield login_db

    from app.core.auth import get_current_user

    async def override_get_current_user():
        return sso_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="https://test"
    ) as client:
        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": "", "new_password": NEW_PASSWORD},
        )
        assert resp.status_code in (400, 422)


@pytest.mark.asyncio
async def test_change_password_local_auth_disabled_404(
    login_db, password_user, monkeypatch
):
    async with _make_client(login_db) as client:
        assert (await _login(client)).status_code == 200
        monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
        monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", False)
        resp = await client.post(
            "/api/auth/change-password",
            json={"current_password": OLD_PASSWORD, "new_password": NEW_PASSWORD},
        )
        assert resp.status_code == 404
