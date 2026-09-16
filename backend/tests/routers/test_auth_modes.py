# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B4: /api/auth/modes — how the SPA learns whether to render a login button.

This is the only auth-related endpoint an anonymous browser may read: a
signed-out user must be able to discover that a login exists. It therefore
returns booleans only — never the issuer URL, client id, or IdP hostname.
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.database import get_db
from app.main import create_app


@pytest_asyncio.fixture
async def auth_db(db_engine):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    async with factory() as session:
        yield session


def _make_client(auth_db: AsyncSession):
    app = create_app()

    async def override_get_db():
        yield auth_db

    app.dependency_overrides[get_db] = override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture
def oidc_production(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example/realms/x")
    monkeypatch.setattr(app_settings, "OIDC_CLIENT_ID", "backplane")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "k")


@pytest.mark.asyncio
async def test_modes_readable_without_authentication(oidc_production, auth_db):
    """A signed-out browser must be able to read this — that is its purpose."""
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/auth/modes")
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_modes_reports_oidc_enabled(oidc_production, auth_db):
    async with _make_client(auth_db) as client:
        body = (await client.get("/api/auth/modes")).json()
    assert body["oidc_enabled"] is True
    assert body["login_path"] == "/api/auth/oidc/login"
    assert body["logout_path"] == "/api/auth/oidc/logout"


@pytest.mark.asyncio
async def test_modes_never_leaks_idp_identifiers(oidc_production, auth_db):
    """Booleans + paths only: no issuer, client id, or IdP hostname."""
    async with _make_client(auth_db) as client:
        raw = (await client.get("/api/auth/modes")).text
    assert "idp.example" not in raw
    assert "backplane" not in raw.lower().replace("backplane_session", "")
    assert "realms" not in raw


@pytest.mark.asyncio
async def test_modes_reports_oidc_disabled_when_unconfigured(auth_db, monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "")
    async with _make_client(auth_db) as client:
        body = (await client.get("/api/auth/modes")).json()
    assert body["oidc_enabled"] is False


@pytest.mark.asyncio
async def test_modes_reports_dev_mode(auth_db, monkeypatch):
    """In dev the SPA must not offer a login button — headers do the work."""
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "")
    async with _make_client(auth_db) as client:
        body = (await client.get("/api/auth/modes")).json()
    assert body["dev_mode"] is True
    assert body["oidc_enabled"] is False


@pytest.mark.asyncio
async def test_modes_oidc_disabled_when_signing_key_missing(auth_db, monkeypatch):
    """Without a signing key no session can be minted — don't advertise login.

    Forced to ENV=development: in production, OIDC_ISSUER set with an empty
    OAUTH_STATE_SIGNING_KEY (b78fd004) now refuses to boot at create_app()
    instead, so the only way left to observe oidc_is_configured()'s own
    signing-key check is outside that gate.
    """
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    monkeypatch.setattr(app_settings, "OIDC_ISSUER", "https://idp.example")
    monkeypatch.setattr(app_settings, "OIDC_CLIENT_ID", "backplane")
    monkeypatch.setattr(app_settings, "OAUTH_STATE_SIGNING_KEY", "")
    async with _make_client(auth_db) as client:
        body = (await client.get("/api/auth/modes")).json()
    assert body["oidc_enabled"] is False
