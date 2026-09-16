# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local login/logout endpoints + password_enabled in /auth/modes (card 5).

The failure contract is the whole point: wrong password, unknown email, and
no-local-credential must be byte-identical on the wire, or the endpoint is a
user-enumeration oracle.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.core.password import hash_password
from app.core.session_cookie import SESSION_COOKIE_NAME
from app.database import get_db
from app.main import create_app
from app.models.user import User

SIGNING_KEY = "login-test-signing-key"
GOOD_PASSWORD = "correct horse battery staple"


@pytest_asyncio.fixture
async def login_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


@pytest.fixture(autouse=True)
def local_auth_only_production(monkeypatch):
    """Local auth as the sole verifier — no dev header fallback in the way."""
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
        password_hash=hash_password(GOOD_PASSWORD),
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


# ── login ──


@pytest.mark.asyncio
async def test_login_valid_credentials_sets_session_cookie(login_db, password_user):
    async with _make_client(login_db) as client:
        resp = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": GOOD_PASSWORD},
        )
        assert resp.status_code == 200
        assert resp.json()["email"] == "pat@example.com"
        assert SESSION_COOKIE_NAME in resp.cookies

        me = await client.get("/api/me")
        assert me.status_code == 200
        assert me.json()["email"] == "pat@example.com"


@pytest.mark.asyncio
async def test_login_wrong_password_uniform_error_no_cookie(login_db, password_user):
    async with _make_client(login_db) as client:
        resp = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": "wrong password"},
        )
        assert resp.status_code == 401
        assert SESSION_COOKIE_NAME not in resp.cookies
        assert "set-cookie" not in resp.headers


@pytest.mark.asyncio
async def test_login_unknown_email_byte_identical_to_wrong_password(
    login_db, password_user
):
    async with _make_client(login_db) as client:
        wrong_password = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": "wrong password"},
        )
        unknown_email = await client.post(
            "/api/auth/login",
            json={"email": "ghost@example.com", "password": "wrong password"},
        )
        assert unknown_email.status_code == wrong_password.status_code
        assert unknown_email.content == wrong_password.content


@pytest.mark.asyncio
async def test_login_null_hash_user_same_uniform_failure(login_db, password_user):
    login_db.add(User(email="sso-only@example.com", name="Sso"))
    await login_db.flush()
    async with _make_client(login_db) as client:
        wrong_password = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": "wrong password"},
        )
        no_credential = await client.post(
            "/api/auth/login",
            json={"email": "sso-only@example.com", "password": "wrong password"},
        )
        assert no_credential.status_code == wrong_password.status_code
        assert no_credential.content == wrong_password.content


@pytest.mark.asyncio
async def test_login_disabled_local_auth_404(login_db, password_user, monkeypatch):
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", False)
    async with _make_client(login_db) as client:
        resp = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": GOOD_PASSWORD},
        )
        assert resp.status_code == 404


# ── lockout + throttle (card 7) ──


def _make_client_with_real_db_semantics(db: AsyncSession) -> AsyncClient:
    """Unlike the plain override, this mirrors app.database.get_db exactly:
    commit on success, ROLLBACK when the request raises. The default test
    override skips that wrapper — which is how the lockout-rollback bug
    reached production and was only caught by the card-9 acceptance run."""
    app = create_app()

    async def override_get_db():
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    app.dependency_overrides[get_db] = override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="https://test")


@pytest.mark.asyncio
async def test_lockout_survives_the_request_rollback(login_db, password_user):
    """The 401 raise rolls the request's transaction back — the failed-attempt
    counter (and the lock) must be committed before that, or lockout never
    persists outside the test harness."""
    from app.services.auth.local_auth import MAX_FAILED_LOGIN_ATTEMPTS

    # Commit the seeded user first — otherwise the request rollback discards
    # the fixture row too and every attempt fails as unknown-email, making
    # this test pass vacuously.
    await login_db.commit()

    async with _make_client_with_real_db_semantics(login_db) as client:
        for _ in range(MAX_FAILED_LOGIN_ATTEMPTS):
            resp = await client.post(
                "/api/auth/login",
                json={"email": "pat@example.com", "password": "wrong password"},
            )
            assert resp.status_code == 401

        locked = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": GOOD_PASSWORD},
        )
        assert locked.status_code == 401


@pytest.mark.asyncio
async def test_login_locked_account_byte_identical_to_unknown_email(
    login_db, password_user
):
    """A locked account must not be distinguishable from a nonexistent one —
    otherwise lockout becomes a user-enumeration oracle."""
    from app.services.auth.local_auth import MAX_FAILED_LOGIN_ATTEMPTS

    async with _make_client(login_db) as client:
        for _ in range(MAX_FAILED_LOGIN_ATTEMPTS):
            await client.post(
                "/api/auth/login",
                json={"email": "pat@example.com", "password": "wrong password"},
            )

        locked_correct = await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": GOOD_PASSWORD},
        )
        unknown = await client.post(
            "/api/auth/login",
            json={"email": "ghost@example.com", "password": GOOD_PASSWORD},
        )
        assert locked_correct.status_code == 401
        assert locked_correct.status_code == unknown.status_code
        assert locked_correct.content == unknown.content
        assert SESSION_COOKIE_NAME not in locked_correct.cookies


@pytest.mark.asyncio
async def test_login_burst_from_one_ip_throttled(login_db):
    from app.core.rate_limit import LOGIN_LIMIT

    async with _make_client(login_db) as client:
        responses = [
            await client.post(
                "/api/auth/login",
                json={"email": f"g{i}@example.com", "password": "wrong password"},
            )
            for i in range(LOGIN_LIMIT + 2)
        ]
    # The first LOGIN_LIMIT attempts pass the throttle (and fail auth);
    # everything past the limit is cut off before touching credentials.
    assert all(r.status_code == 401 for r in responses[:LOGIN_LIMIT])
    assert all(r.status_code == 429 for r in responses[LOGIN_LIMIT:])


@pytest.mark.asyncio
async def test_login_throttle_is_tighter_than_general_traffic(login_db):
    """The login endpoint gets its own budget: the general unauthenticated
    tier must not be consumed by (or shared with) password attempts."""
    from app.core.rate_limit import LOGIN_LIMIT, UNAUTHENTICATED_LIMIT

    assert LOGIN_LIMIT < UNAUTHENTICATED_LIMIT

    async with _make_client(login_db) as client:
        for _ in range(LOGIN_LIMIT + 1):
            resp = await client.post(
                "/api/auth/login",
                json={"email": "ghost@example.com", "password": "wrong password"},
            )
        assert resp.status_code == 429
        # General unauthenticated traffic from the same IP still flows.
        assert (await client.get("/api/auth/modes")).status_code == 200


# ── logout ──


@pytest.mark.asyncio
async def test_logout_clears_cookie_and_deauthenticates(login_db, password_user):
    async with _make_client(login_db) as client:
        await client.post(
            "/api/auth/login",
            json={"email": "pat@example.com", "password": GOOD_PASSWORD},
        )
        assert (await client.get("/api/me")).status_code == 200

        resp = await client.post("/api/auth/logout")
        assert resp.status_code == 204
        assert (await client.get("/api/me")).status_code == 403


@pytest.mark.asyncio
async def test_logout_twice_is_fine(login_db):
    async with _make_client(login_db) as client:
        assert (await client.post("/api/auth/logout")).status_code == 204
        assert (await client.post("/api/auth/logout")).status_code == 204


# ── /auth/modes ──


@pytest.mark.asyncio
async def test_modes_reports_password_enabled(login_db):
    async with _make_client(login_db) as client:
        resp = await client.get("/api/auth/modes")
        assert resp.json()["password_enabled"] is True


@pytest.mark.asyncio
async def test_modes_password_disabled_when_local_auth_off(login_db, monkeypatch):
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", False)
    async with _make_client(login_db) as client:
        resp = await client.get("/api/auth/modes")
        assert resp.json()["password_enabled"] is False


@pytest.mark.asyncio
async def test_modes_password_disabled_without_signing_key(login_db, monkeypatch):
    """Without a session signing key no login could ever mint a session, so
    the SPA must not render a password form that cannot work.

    Forced to ENV=development: in production this combination (b78fd004) now
    refuses to boot at create_app() instead, so the only way left to observe
    password_is_enabled()'s own signing-key check is outside that gate.
    """
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")
    async with _make_client(login_db) as client:
        resp = await client.get("/api/auth/modes")
        assert resp.json()["password_enabled"] is False


# ── cookie Secure flag follows the public origin's scheme ──


async def _login_set_cookie_header(client: AsyncClient) -> str:
    resp = await client.post(
        "/api/auth/login",
        json={"email": "pat@example.com", "password": GOOD_PASSWORD},
    )
    assert resp.status_code == 200
    return resp.headers["set-cookie"]


@pytest.mark.asyncio
async def test_login_cookie_not_secure_on_http_origin(
    login_db, password_user, monkeypatch
):
    """An http:// deployment must mint a cookie the browser will keep.

    `secure=not is_development` bricked login on plain-http self-hosts
    (http://<lan-ip>:8080): browsers silently drop Secure cookies over http
    everywhere except localhost, so a correct login bounced straight back to
    the form with no error.
    """
    monkeypatch.setattr(app_settings, "FRONTEND_URL", "http://192.168.1.50:8080")
    async with _make_client(login_db) as client:
        header = await _login_set_cookie_header(client)
    assert "; secure" not in header.lower()


@pytest.mark.asyncio
async def test_login_cookie_secure_on_https_origin(
    login_db, password_user, monkeypatch
):
    monkeypatch.setattr(app_settings, "FRONTEND_URL", "https://backplane.example")
    async with _make_client(login_db) as client:
        header = await _login_set_cookie_header(client)
    assert "; secure" in header.lower()
