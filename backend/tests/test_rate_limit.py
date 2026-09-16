# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import rate_limit as rate_limit_module
from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.user import User


@pytest.fixture
def rate_limited_app(db_session: AsyncSession, test_user: User):
    """Create a fresh app instance for rate limit testing."""
    app = create_app()

    async def override_get_db():
        yield db_session

    async def override_get_current_user():
        return test_user

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user
    return app


@pytest.mark.asyncio
async def test_rate_limit_headers_present(rate_limited_app, test_user):
    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/health")
        assert resp.status_code == 200
        assert "x-ratelimit-limit" in resp.headers
        assert "x-ratelimit-remaining" in resp.headers


@pytest.mark.asyncio
async def test_rate_limit_decrements(rate_limited_app, test_user):
    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp1 = await ac.get("/api/health")
        remaining1 = int(resp1.headers["x-ratelimit-remaining"])

        resp2 = await ac.get("/api/health")
        remaining2 = int(resp2.headers["x-ratelimit-remaining"])

        assert remaining2 < remaining1


@pytest.mark.asyncio
async def test_rate_limit_returns_429_when_exceeded(rate_limited_app, test_user):
    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Exhaust rate limit by sending many requests
        # The health endpoint is unauthenticated, so uses IP-based limiting
        for _ in range(65):
            await ac.get("/api/health")

        resp = await ac.get("/api/health")
        assert resp.status_code == 429
        body = resp.json()
        assert body == {
            "detail": "Rate limit exceeded. Try again later.",
            "error_code": "rate_limited",
            "error_params": {
                "limit": rate_limit_module.UNAUTHENTICATED_LIMIT,
                "retry_after_seconds": rate_limit_module.WINDOW_SECONDS,
            },
            "context": None,
        }


@pytest.mark.asyncio
async def test_rate_limit_different_limits_for_api_key(rate_limited_app, test_user):
    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        # Authenticated requests get higher limits
        resp = await ac.get(
            "/api/health",
            headers={"X-User-Email": "dev@valaris.dev"},
        )
        limit = int(resp.headers["x-ratelimit-limit"])
        # Authenticated limit should be higher than unauthenticated (60)
        assert limit >= 60


@pytest.mark.asyncio
async def test_rate_limit_ignores_spoofed_email_in_untrusted_prod(
    rate_limited_app, test_user, monkeypatch
):
    """Without IAP verification, the email header is spoofable: a client must
    not be able to rotate x-user-email to claim the authed tier or dodge the
    counter. Keying falls back to the real client IP + unauthenticated limit."""
    monkeypatch.setattr(rate_limit_module.settings, "ENV", "production")
    monkeypatch.setattr(rate_limit_module.settings, "IAP_AUDIENCE", "")

    transport = ASGITransport(app=rate_limited_app, client=("203.0.113.7", 12345))
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        first = await ac.get("/api/health", headers={"X-User-Email": "a@valaris.dev"})
        assert int(first.headers["x-ratelimit-limit"]) == 60
        remaining_first = int(first.headers["x-ratelimit-remaining"])

        # Rotating the header must NOT open a fresh window — same IP key.
        second = await ac.get("/api/health", headers={"X-User-Email": "b@valaris.dev"})
        assert int(second.headers["x-ratelimit-limit"]) == 60
        assert int(second.headers["x-ratelimit-remaining"]) < remaining_first


@pytest.mark.asyncio
async def test_rate_limit_trusts_email_when_iap_configured(
    rate_limited_app, test_user, monkeypatch
):
    """With IAP_AUDIENCE set, IAP verifies the header upstream — trust it for
    the authenticated tier."""
    monkeypatch.setattr(rate_limit_module.settings, "ENV", "production")
    monkeypatch.setattr(rate_limit_module.settings, "IAP_AUDIENCE", "some-audience")

    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/health", headers={"X-User-Email": "a@valaris.dev"})
        assert int(resp.headers["x-ratelimit-limit"]) == 300


@pytest.mark.asyncio
async def test_rate_limit_trusts_proxy_header_when_proxy_auth_enabled(
    rate_limited_app, test_user, monkeypatch
):
    """With TRUSTED_PROXY_AUTH on, the proxy-verified identity header keys the
    authenticated tier — otherwise every user behind the proxy shares the
    proxy's client IP and one unauthenticated window throttles the instance."""
    monkeypatch.setattr(rate_limit_module.settings, "ENV", "production")
    monkeypatch.setattr(rate_limit_module.settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(rate_limit_module.settings, "TRUSTED_PROXY_AUTH", True)
    monkeypatch.setattr(
        rate_limit_module.settings, "TRUSTED_PROXY_AUTH_HEADER", "X-Forwarded-Email"
    )

    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/health", headers={"X-Forwarded-Email": "a@valaris.dev"})
        assert int(resp.headers["x-ratelimit-limit"]) == 300


@pytest.mark.asyncio
async def test_rate_limit_trusts_email_in_development(
    rate_limited_app, test_user, monkeypatch
):
    """Dev mode has no upstream verifier but is not an untrusted deployment;
    keep the existing email-keyed authenticated behavior."""
    monkeypatch.setattr(rate_limit_module.settings, "ENV", "development")
    monkeypatch.setattr(rate_limit_module.settings, "IAP_AUDIENCE", "")

    transport = ASGITransport(app=rate_limited_app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/health", headers={"X-User-Email": "a@valaris.dev"})
        assert int(resp.headers["x-ratelimit-limit"]) == 300
