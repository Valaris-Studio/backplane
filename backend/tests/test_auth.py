# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import get_db
from app.main import create_app


@pytest_asyncio.fixture
async def auth_db(db_engine):
    # Reuses conftest's per-test engine: a private :memory: DB on a StaticPool
    # (single shared connection). The module-level engine this replaced used
    # the DEFAULT pool, where create_all and the session could check out
    # DIFFERENT connections — i.e. different in-memory DBs — a latent
    # "no such table" flake.
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session


def _make_client(auth_db: AsyncSession):
    """Create a test client that does NOT override get_current_user (exercises real auth)."""
    app = create_app()

    async def override_get_db():
        yield auth_db

    app.dependency_overrides[get_db] = override_get_db
    # Intentionally no override for get_current_user
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _hardening_defaults(mock_settings):
    """New Part-A settings must be real values, not truthy MagicMocks."""
    mock_settings.TRUSTED_PROXY_SECRET = ""
    mock_settings.AUTH_ALLOWED_EMAIL_DOMAINS = ""
    mock_settings.AUTH_AUTO_PROVISION = True


# ── Dev mode (default) ──


@pytest.mark.asyncio
async def test_dev_mode_uses_x_user_email_header(auth_db):
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces",
            headers={"X-User-Email": "alice@valaris.dev"},
        )
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_dev_mode_falls_back_to_default_email(auth_db):
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/workspaces")
        assert resp.status_code == 200


# ── Prod mode, no verifier configured (fail closed) ──
#
# _hardening_defaults never sets LOCAL_AUTH_ENABLED/OIDC_ISSUER, so on the
# MagicMock they stay truthy by default — same as real prod, where
# LOCAL_AUTH_ENABLED defaults to True. That means these two exercise the
# "a login verifier IS configured, you're just not signed in" branch; the
# genuinely-nothing-configured branch is covered separately below with both
# explicitly turned off.


@pytest.mark.asyncio
async def test_prod_no_verifier_rejects_spoofed_identity_header(auth_db):
    """The header is only meaningful behind a proxy; without the opt-in it is attacker-controlled."""
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = ""
        mock_settings.TRUSTED_PROXY_AUTH = False

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={
                    "X-Goog-Authenticated-User-Email": "accounts.google.com:bob@valaris.studio"
                },
            )
            assert resp.status_code == 403


@pytest.mark.asyncio
async def test_prod_no_verifier_no_header_returns_403(auth_db):
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = ""
        mock_settings.TRUSTED_PROXY_AUTH = False

        async with _make_client(auth_db) as client:
            resp = await client.get("/api/workspaces")
            assert resp.status_code == 403


@pytest.mark.asyncio
async def test_prod_login_verifier_configured_not_authenticated_message(auth_db):
    """LOCAL_AUTH_ENABLED=true (self-host default) + no session cookie: say 'not authenticated',
    never 'no verifier configured' — a login path exists, the caller just hasn't used it."""
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = ""
        mock_settings.TRUSTED_PROXY_AUTH = False
        mock_settings.LOCAL_AUTH_ENABLED = True
        mock_settings.OIDC_ISSUER = ""

        async with _make_client(auth_db) as client:
            resp = await client.get("/api/workspaces")
            assert resp.status_code == 403
            detail = resp.json()["detail"]
            assert "no verifier" not in detail.lower()
            assert "not authenticated" in detail.lower()


@pytest.mark.asyncio
async def test_prod_genuinely_nothing_configured_lists_all_options(auth_db):
    """With LOCAL_AUTH_ENABLED and OIDC_ISSUER both off too, the old message survives but
    must now enumerate every current option, mirroring main.py's startup check."""
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = ""
        mock_settings.TRUSTED_PROXY_AUTH = False
        mock_settings.LOCAL_AUTH_ENABLED = False
        mock_settings.OIDC_ISSUER = ""

        async with _make_client(auth_db) as client:
            resp = await client.get("/api/workspaces")
            assert resp.status_code == 403
            detail = resp.json()["detail"]
            assert "LOCAL_AUTH_ENABLED" in detail
            assert "OIDC_ISSUER" in detail
            assert "IAP_AUDIENCE" in detail
            assert "TRUSTED_PROXY_AUTH" in detail


# ── Prod mode, TRUSTED_PROXY_AUTH opt-in ──


@pytest.mark.asyncio
async def test_trusted_proxy_auth_accepts_identity_header(auth_db):
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = ""
        mock_settings.TRUSTED_PROXY_AUTH = True
        mock_settings.TRUSTED_PROXY_AUTH_HEADER = "X-Goog-Authenticated-User-Email"

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={
                    "X-Goog-Authenticated-User-Email": "accounts.google.com:bob@valaris.studio"
                },
            )
            assert resp.status_code == 200


@pytest.mark.asyncio
async def test_trusted_proxy_auth_reads_configured_header_only(auth_db):
    """oauth2-proxy sets X-Forwarded-Email; the Google header must not be a second way in."""
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = ""
        mock_settings.TRUSTED_PROXY_AUTH = True
        mock_settings.TRUSTED_PROXY_AUTH_HEADER = "X-Forwarded-Email"

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Forwarded-Email": "dana@valaris.studio"},
            )
            assert resp.status_code == 200

            ignored = await client.get(
                "/api/workspaces",
                headers={"X-Goog-Authenticated-User-Email": "eve@valaris.studio"},
            )
            assert ignored.status_code == 403


@pytest.mark.asyncio
async def test_trusted_proxy_auth_takes_second_place_to_iap(auth_db):
    """With both configured, the verifying path wins — the header is never consulted."""
    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
    ):
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"
        mock_settings.TRUSTED_PROXY_AUTH = True
        mock_settings.TRUSTED_PROXY_AUTH_HEADER = "X-Goog-Authenticated-User-Email"
        mock_verify.return_value = {"email": "carol@valaris.studio"}

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Goog-Authenticated-User-Email": "mallory@evil.example"},
            )
            assert resp.status_code == 403  # no IAP JWT presented


# ── Prod mode, IAP_AUDIENCE set (JWT validation) ──


@pytest.mark.asyncio
async def test_prod_valid_jwt_extracts_email(auth_db):
    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
    ):
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"
        mock_verify.return_value = {"email": "carol@valaris.studio", "sub": "123"}

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Goog-IAP-JWT-Assertion": "valid.jwt.token"},
            )
            assert resp.status_code == 200
            mock_verify.assert_called_once()


@pytest.mark.asyncio
async def test_prod_missing_jwt_returns_403(auth_db):
    with patch("app.core.auth.settings") as mock_settings:
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"

        async with _make_client(auth_db) as client:
            resp = await client.get("/api/workspaces")
            assert resp.status_code == 403


@pytest.mark.asyncio
async def test_prod_invalid_jwt_returns_403(auth_db):
    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
    ):
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"
        mock_verify.side_effect = ValueError("Invalid token")

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Goog-IAP-JWT-Assertion": "bad.jwt.token"},
            )
            assert resp.status_code == 403


@pytest.mark.asyncio
async def test_prod_jwt_missing_email_claim_returns_403(auth_db):
    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
    ):
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"
        mock_verify.return_value = {"sub": "123"}  # no email claim

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Goog-IAP-JWT-Assertion": "valid.jwt.no.email"},
            )
            assert resp.status_code == 403


@pytest.mark.asyncio
async def test_prod_jwt_fallback_header_extracts_email(auth_db):
    """Cloud Run's GFE strips X-Goog-IAP-JWT-Assertion on proxy hops; the nginx
    frontend re-sends it as X-IAP-JWT-Assertion, which must authenticate."""
    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
    ):
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"
        mock_verify.return_value = {"email": "carol@valaris.studio", "sub": "123"}

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-IAP-JWT-Assertion": "proxied.jwt.token"},
            )
            assert resp.status_code == 200
            assert mock_verify.call_args[0][0] == "proxied.jwt.token"


@pytest.mark.asyncio
async def test_prod_jwt_prefers_google_header_over_fallback(auth_db):
    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
    ):
        mock_settings.is_development = False
        _hardening_defaults(mock_settings)
        mock_settings.IAP_AUDIENCE = "/projects/123/global/backendServices/456"
        mock_verify.return_value = {"email": "carol@valaris.studio", "sub": "123"}

        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={
                    "X-Goog-IAP-JWT-Assertion": "google.jwt.token",
                    "X-IAP-JWT-Assertion": "proxied.jwt.token",
                },
            )
            assert resp.status_code == 200
            assert mock_verify.call_args[0][0] == "google.jwt.token"


# ── Shared IAP JWT extraction (HTTP + WS consume the same helper) ──


def test_extract_iap_jwt_reads_google_header():
    from app.core.auth import extract_iap_jwt

    headers = {"X-Goog-IAP-JWT-Assertion": "google.jwt"}
    assert extract_iap_jwt(headers.get) == "google.jwt"


def test_extract_iap_jwt_falls_back_to_proxied_copy():
    from app.core.auth import extract_iap_jwt

    headers = {"X-IAP-JWT-Assertion": "proxied.jwt"}
    assert extract_iap_jwt(headers.get) == "proxied.jwt"


def test_extract_iap_jwt_handles_lowercased_ws_headers():
    from app.core.auth import extract_iap_jwt

    assert extract_iap_jwt({"x-goog-iap-jwt-assertion": "g.jwt"}.get) == "g.jwt"
    assert extract_iap_jwt({"x-iap-jwt-assertion": "p.jwt"}.get) == "p.jwt"


def test_extract_iap_jwt_empty_when_absent():
    from app.core.auth import extract_iap_jwt

    assert extract_iap_jwt({}.get) == ""


# ── Production startup gate ──


def _patch_prod_settings(monkeypatch, *, iap_audience="", trusted_proxy_auth=False):
    # create_app() already ran at import under dev settings; patch at call time.
    from app.config import settings as app_settings

    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", iap_audience)
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", trusted_proxy_auth)
    # Local auth is a verifier in its own right (L4) and defaults ON — turn it
    # off so these tests still exercise the no-verifier refusal.
    monkeypatch.setattr(app_settings, "LOCAL_AUTH_ENABLED", False)


def test_production_refuses_to_start_without_a_verifier(monkeypatch):
    _patch_prod_settings(monkeypatch)

    with pytest.raises(RuntimeError, match="IAP_AUDIENCE|TRUSTED_PROXY_AUTH"):
        create_app()


def test_production_starts_with_iap_audience(monkeypatch):
    _patch_prod_settings(
        monkeypatch, iap_audience="/projects/123/global/backendServices/456"
    )

    assert create_app() is not None


def test_production_starts_with_trusted_proxy_auth(monkeypatch):
    _patch_prod_settings(monkeypatch, trusted_proxy_auth=True)

    assert create_app() is not None


def test_development_starts_without_a_verifier():
    assert create_app() is not None


# ── OpenAPI schema exposure ──


@pytest.mark.asyncio
async def test_openapi_schema_served_in_production(auth_db, monkeypatch):
    """Self-hosters generate clients from this; only the interactive docs UI is dev-only."""
    _patch_prod_settings(monkeypatch, trusted_proxy_auth=True)

    async with _make_client(auth_db) as client:
        resp = await client.get("/api/openapi.json")
        assert resp.status_code == 200
        assert resp.json()["info"]["title"] == "Backplane"

        assert (await client.get("/api/docs")).status_code == 404


@pytest.mark.asyncio
async def test_openapi_schema_served_in_development(auth_db):
    async with _make_client(auth_db) as client:
        assert (await client.get("/api/openapi.json")).status_code == 200
        assert (await client.get("/api/docs")).status_code == 200
