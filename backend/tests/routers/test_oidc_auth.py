# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B2: the OIDC login / callback / logout router.

The IdP is the B1 fixture (`tests/core/test_oidc.FixtureIdp`) behind an
`httpx.MockTransport`, injected by overriding the router's client dependency —
no network, no real IdP. Error branches must redirect with an opaque code and
never echo a token, a code, or an upstream body.
"""

from __future__ import annotations

from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.core.oidc import OidcClient
from app.core.session_cookie import SESSION_COOKIE_NAME, read_session
from app.database import get_db
from app.main import create_app
from app.models.user import User
from app.routers.auth import oidc as oidc_router
from tests.core.test_oidc import CLIENT_ID, FixtureIdp

SIGNING_KEY = "oidc-router-signing-key"


@pytest_asyncio.fixture
async def auth_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


@pytest.fixture
def idp() -> FixtureIdp:
    return FixtureIdp()


@pytest.fixture
def oidc_settings(monkeypatch, idp):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", idp.issuer)
    monkeypatch.setattr(app_settings, "OIDC_CLIENT_ID", CLIENT_ID)
    monkeypatch.setattr(app_settings, "OIDC_CLIENT_SECRET", "s3cret")
    monkeypatch.setattr(app_settings, "OIDC_SCOPES", "openid email profile")
    monkeypatch.setattr(app_settings, "OIDC_SESSION_TTL_SECONDS", 43200)
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", SIGNING_KEY)
    monkeypatch.setattr(app_settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "")
    monkeypatch.setattr(app_settings, "AUTH_AUTO_PROVISION", True)
    monkeypatch.setattr(app_settings, "FRONTEND_URL", "https://app.example")
    monkeypatch.setattr(app_settings, "API_URL", "https://api.example")


def _client(auth_db: AsyncSession, idp: FixtureIdp, token_handler=None):
    app = create_app()

    async def override_get_db():
        yield auth_db

    app.dependency_overrides[get_db] = override_get_db

    handler = token_handler or _default_token_handler(idp)

    def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(handler))

    def build_client() -> OidcClient:
        return OidcClient(
            issuer=app_settings.OIDC_ISSUER,
            client_id=app_settings.OIDC_CLIENT_ID,
            client_secret=app_settings.OIDC_CLIENT_SECRET,
            http_client_factory=factory,
        )

    app.dependency_overrides[oidc_router.get_oidc_client] = build_client
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _default_token_handler(idp: FixtureIdp, **token_claims):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/protocol/openid-connect/token"):
            # The nonce the login leg generated must round-trip into the token.
            nonce = handler.nonce_for_token or ""
            return FixtureIdp._json(
                {
                    "id_token": idp.id_token(nonce=nonce, **token_claims),
                    "token_type": "Bearer",
                }
            )
        return idp.handler(request)

    handler.nonce_for_token = None
    return handler


async def _begin_login(client: AsyncClient) -> tuple[str, str, dict[str, str]]:
    """Run the login leg; return (state, nonce, cookies to replay on callback)."""
    resp = await client.get("/api/auth/oidc/login", follow_redirects=False)
    assert resp.status_code == 302
    query = parse_qs(urlsplit(resp.headers["location"]).query)
    cookies = {k: v for k, v in resp.cookies.items()}
    return query["state"][0], query["nonce"][0], cookies


# ── login leg ──


@pytest.mark.asyncio
async def test_login_redirects_to_idp_with_pkce(oidc_settings, auth_db, idp):
    async with _client(auth_db, idp) as client:
        resp = await client.get("/api/auth/oidc/login", follow_redirects=False)

    assert resp.status_code == 302
    target = urlsplit(resp.headers["location"])
    query = parse_qs(target.query)
    assert target.netloc == urlsplit(idp.issuer).netloc
    assert query["response_type"] == ["code"]
    assert query["client_id"] == [CLIENT_ID]
    assert query["scope"] == ["openid email profile"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"][0]
    assert query["state"][0] and query["nonce"][0]
    assert query["redirect_uri"] == ["https://api.example/api/auth/oidc/callback"]


@pytest.mark.asyncio
async def test_login_sets_signed_state_cookie(oidc_settings, auth_db, idp):
    async with _client(auth_db, idp) as client:
        resp = await client.get("/api/auth/oidc/login", follow_redirects=False)

    cookie = resp.cookies.get(oidc_router.OIDC_STATE_COOKIE_NAME)
    assert cookie, "login must persist state/nonce/verifier in a signed cookie"
    header = resp.headers["set-cookie"]
    assert "HttpOnly" in header and "Secure" in header


@pytest.mark.asyncio
async def test_login_never_puts_the_code_verifier_in_the_url(
    oidc_settings, auth_db, idp
):
    """PKCE only works if the verifier stays out of the front channel."""
    async with _client(auth_db, idp) as client:
        resp = await client.get("/api/auth/oidc/login", follow_redirects=False)
    assert "code_verifier" not in resp.headers["location"]


@pytest.mark.asyncio
async def test_login_when_oidc_not_configured_redirects_with_error(
    oidc_settings, auth_db, idp, monkeypatch
):
    """A deployment using another tier still exposes the route — it must not 500."""
    async with _client(auth_db, idp) as client:
        # Unset after create_app so the startup gate (which OIDC also satisfies)
        # isn't what we end up testing here.
        monkeypatch.setattr(app_settings, "OIDC_ISSUER", "")
        resp = await client.get("/api/auth/oidc/login", follow_redirects=False)
    assert resp.status_code == 302
    assert "code=oidc_not_configured" in resp.headers["location"]


# ── callback leg ──


@pytest.mark.asyncio
async def test_callback_happy_path_provisions_user_and_sets_session(
    oidc_settings, auth_db, idp
):
    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "auth-code", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )

    assert resp.status_code == 302
    assert resp.headers["location"].startswith("https://app.example")
    raw = resp.cookies.get(SESSION_COOKIE_NAME)
    assert raw, "callback must mint a session cookie"

    user_id = read_session(raw, signing_key=SIGNING_KEY, max_age=43200)
    user = (
        await auth_db.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()
    assert user is not None and user.email == "alice@valaris.studio"


@pytest.mark.asyncio
async def test_callback_session_cookie_is_httponly_and_secure(
    oidc_settings, auth_db, idp
):
    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    session_header = [
        h for h in resp.headers.get_list("set-cookie") if SESSION_COOKIE_NAME in h
    ][0]
    assert "HttpOnly" in session_header
    assert "Secure" in session_header
    assert "samesite=lax" in session_header.lower()


@pytest.mark.asyncio
async def test_callback_rejects_state_mismatch(oidc_settings, auth_db, idp):
    async with _client(auth_db, idp) as client:
        _, _, cookies = await _begin_login(client)
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": "not-the-state"},
            cookies=cookies,
            follow_redirects=False,
        )
    assert resp.status_code == 302
    assert "code=state_mismatch" in resp.headers["location"]
    assert SESSION_COOKIE_NAME not in resp.cookies


@pytest.mark.asyncio
async def test_callback_without_state_cookie_is_rejected(oidc_settings, auth_db, idp):
    async with _client(auth_db, idp) as client:
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": "s"},
            follow_redirects=False,
        )
    assert "code=missing_state_or_code" in resp.headers["location"]


@pytest.mark.asyncio
async def test_callback_propagates_idp_error_opaquely(oidc_settings, auth_db, idp):
    async with _client(auth_db, idp) as client:
        _, _, cookies = await _begin_login(client)
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"error": "access_denied"},
            cookies=cookies,
            follow_redirects=False,
        )
    assert "code=access_denied" in resp.headers["location"]


@pytest.mark.asyncio
async def test_callback_rejects_nonce_mismatch(oidc_settings, auth_db, idp):
    """An ID token minted for a different login must not be accepted."""
    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, _, cookies = await _begin_login(client)
        handler.nonce_for_token = "a-nonce-from-another-login"
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    assert "code=" in resp.headers["location"]
    assert SESSION_COOKIE_NAME not in resp.cookies


@pytest.mark.asyncio
async def test_callback_error_never_leaks_upstream_body(oidc_settings, auth_db, idp):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/protocol/openid-connect/token"):
            return httpx.Response(400, content=b"client_secret=hunter2 rejected")
        return idp.handler(request)

    async with _client(auth_db, idp, token_handler=handler) as client:
        state, _, cookies = await _begin_login(client)
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    assert "hunter2" not in resp.headers["location"]
    assert SESSION_COOKIE_NAME not in resp.cookies


@pytest.mark.asyncio
async def test_callback_state_cookie_is_cleared_after_use(oidc_settings, auth_db, idp):
    """One-shot state: replaying the same login leg must not work twice."""
    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    cleared = [
        h
        for h in resp.headers.get_list("set-cookie")
        if oidc_router.OIDC_STATE_COOKIE_NAME in h
    ]
    assert cleared and ("Max-Age=0" in cleared[0] or "01 Jan 1970" in cleared[0])


# ── provisioning policy (A2 + A3 reuse) ──


@pytest.mark.asyncio
async def test_callback_enforces_email_domain_allowlist(
    oidc_settings, auth_db, idp, monkeypatch
):
    monkeypatch.setattr(app_settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "corp.example")
    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    assert "code=email_domain_not_allowed" in resp.headers["location"]
    assert SESSION_COOKIE_NAME not in resp.cookies


@pytest.mark.asyncio
async def test_callback_respects_auto_provision_off(
    oidc_settings, auth_db, idp, monkeypatch
):
    monkeypatch.setattr(app_settings, "AUTH_AUTO_PROVISION", False)
    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    assert "code=user_not_provisioned" in resp.headers["location"]


@pytest.mark.asyncio
async def test_callback_signs_in_existing_user_when_auto_provision_off(
    oidc_settings, auth_db, idp, monkeypatch
):
    auth_db.add(User(email="alice@valaris.studio", name="Alice"))
    await auth_db.flush()
    monkeypatch.setattr(app_settings, "AUTH_AUTO_PROVISION", False)

    handler = _default_token_handler(idp)
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )
    assert resp.cookies.get(SESSION_COOKIE_NAME)


# ── logout ──


@pytest.mark.asyncio
async def test_logout_clears_session_cookie(oidc_settings, auth_db, idp):
    async with _client(auth_db, idp) as client:
        resp = await client.get("/api/auth/oidc/logout", follow_redirects=False)
    assert resp.status_code == 302
    cleared = [
        h for h in resp.headers.get_list("set-cookie") if SESSION_COOKIE_NAME in h
    ]
    assert cleared and ("Max-Age=0" in cleared[0] or "01 Jan 1970" in cleared[0])


@pytest.mark.asyncio
async def test_logout_redirects_to_idp_end_session_when_available(
    oidc_settings, auth_db, idp
):
    async with _client(auth_db, idp) as client:
        resp = await client.get("/api/auth/oidc/logout", follow_redirects=False)
    assert idp.discovery["end_session_endpoint"] in resp.headers["location"]


@pytest.mark.asyncio
async def test_logout_falls_back_to_frontend_when_idp_has_no_end_session(
    oidc_settings, auth_db, idp
):
    discovery = {k: v for k, v in idp.discovery.items() if k != "end_session_endpoint"}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/.well-known/openid-configuration"):
            return FixtureIdp._json(discovery)
        return idp.handler(request)

    async with _client(auth_db, idp, token_handler=handler) as client:
        resp = await client.get("/api/auth/oidc/logout", follow_redirects=False)
    assert resp.headers["location"].startswith("https://app.example")


@pytest.mark.asyncio
async def test_logout_survives_unreachable_idp(oidc_settings, auth_db, idp):
    """Signing out must always clear the local session, IdP up or down."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("idp down")

    async with _client(auth_db, idp, token_handler=handler) as client:
        resp = await client.get("/api/auth/oidc/logout", follow_redirects=False)
    assert resp.status_code == 302
    assert [h for h in resp.headers.get_list("set-cookie") if SESSION_COOKIE_NAME in h]


@pytest.mark.asyncio
async def test_oidc_provision_case_variant_resolves_same_user(
    oidc_settings, auth_db, idp
):
    """The IdP asserting a case variant of a known email signs in the EXISTING
    user — the callback must not mint a duplicate identity row."""
    existing = User(email="alice@valaris.studio", name="Alice")
    auth_db.add(existing)
    await auth_db.flush()

    handler = _default_token_handler(idp, email="Alice@VALARIS.studio")
    async with _client(auth_db, idp, token_handler=handler) as client:
        state, nonce, cookies = await _begin_login(client)
        handler.nonce_for_token = nonce
        resp = await client.get(
            "/api/auth/oidc/callback",
            params={"code": "c", "state": state},
            cookies=cookies,
            follow_redirects=False,
        )

    raw = resp.cookies.get(SESSION_COOKIE_NAME)
    assert raw, "case variant of a provisioned user must sign in"
    user_id = read_session(raw, signing_key=SIGNING_KEY, max_age=43200)
    assert str(user_id) == str(existing.id)

    users = (await auth_db.execute(select(User))).scalars().all()
    assert len(users) == 1
