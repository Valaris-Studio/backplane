# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Part A auth hardening: audit logging, proxy secret, domain allowlist, provisioning toggle.

All three auth consumers are covered: HTTP (`get_current_user`), WebSocket
(`_authenticate_ws`), and the rate limiter tier (`_get_client_key`). Settings
are monkeypatched on the real object so every module that imported it sees the
same values.
"""

import logging
from types import SimpleNamespace

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import settings as app_settings
from app.core.rate_limit import (
    AUTHENTICATED_LIMIT,
    LOGIN_LIMIT,
    UNAUTHENTICATED_LIMIT,
    RateLimitMiddleware,
)
from app.database import get_db
from app.main import create_app

PROXY_EMAIL_HEADER = "X-Goog-Authenticated-User-Email"


@pytest_asyncio.fixture
async def auth_db(db_engine):
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session


def _make_client(auth_db: AsyncSession):
    app = create_app()

    async def override_get_db():
        yield auth_db

    app.dependency_overrides[get_db] = override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _trusted_proxy_settings(monkeypatch, **overrides):
    values = {
        "ENV": "production",
        "IAP_AUDIENCE": "",
        "TRUSTED_PROXY_AUTH": True,
        "TRUSTED_PROXY_AUTH_HEADER": PROXY_EMAIL_HEADER,
        "TRUSTED_PROXY_SECRET": "",
        "AUTH_ALLOWED_EMAIL_DOMAINS": "",
        "AUTH_AUTO_PROVISION": True,
        **overrides,
    }
    for key, value in values.items():
        monkeypatch.setattr(app_settings, key, value)


def _fake_ws(headers: dict[str, str], query_params: dict[str, str] | None = None):
    return SimpleNamespace(headers=headers, query_params=query_params or {})


@pytest_asyncio.fixture
async def ws_session_factory(db_engine, monkeypatch):
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    import app.routers.events as events_module

    monkeypatch.setattr(events_module, "async_session", factory)
    return factory


# ── A1: shared-secret proxy handshake ──


@pytest.mark.asyncio
async def test_proxy_secret_unset_keeps_current_behavior(monkeypatch, auth_db):
    _trusted_proxy_settings(monkeypatch)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "bob@valaris.studio"}
        )
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_proxy_secret_required_when_configured(monkeypatch, auth_db):
    _trusted_proxy_settings(monkeypatch, TRUSTED_PROXY_SECRET="s3cret")
    async with _make_client(auth_db) as client:
        missing = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "bob@valaris.studio"}
        )
        assert missing.status_code == 403

        wrong = await client.get(
            "/api/workspaces",
            headers={
                PROXY_EMAIL_HEADER: "bob@valaris.studio",
                "X-Backplane-Proxy-Secret": "wrong",
            },
        )
        assert wrong.status_code == 403

        right = await client.get(
            "/api/workspaces",
            headers={
                PROXY_EMAIL_HEADER: "bob@valaris.studio",
                "X-Backplane-Proxy-Secret": "s3cret",
            },
        )
        assert right.status_code == 200


@pytest.mark.asyncio
async def test_ws_proxy_secret_enforced(monkeypatch, ws_session_factory):
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch, TRUSTED_PROXY_SECRET="s3cret")

    user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio"})
    )
    assert user is None

    user, _ = await _authenticate_ws(
        _fake_ws(
            {
                PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio",
                "x-backplane-proxy-secret": "s3cret",
            }
        )
    )
    assert user is not None and user.email == "bob@valaris.studio"


def test_rate_limiter_denies_authed_tier_without_secret(monkeypatch):
    _trusted_proxy_settings(monkeypatch, TRUSTED_PROXY_SECRET="s3cret")
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)

    def request_with(headers: dict[str, str]):
        return SimpleNamespace(
            headers=headers,
            client=SimpleNamespace(host="10.0.0.9"),
            method="GET",
            url=SimpleNamespace(path="/api/health"),
        )

    key, limit = limiter._get_client_key(
        request_with({PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio"})
    )
    assert key.startswith("ip:") and limit == UNAUTHENTICATED_LIMIT

    key, limit = limiter._get_client_key(
        request_with(
            {
                PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio",
                "x-backplane-proxy-secret": "s3cret",
            }
        )
    )
    assert key.startswith("user:") and limit == AUTHENTICATED_LIMIT


# ── A2: email domain allowlist ──


@pytest.mark.asyncio
async def test_domain_allowlist_blocks_other_domains(monkeypatch, auth_db):
    _trusted_proxy_settings(
        monkeypatch, AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio, example.org"
    )
    async with _make_client(auth_db) as client:
        allowed = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "bob@valaris.studio"}
        )
        assert allowed.status_code == 200

        second = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "ann@example.org"}
        )
        assert second.status_code == 200

        blocked = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "mallory@evil.example"}
        )
        assert blocked.status_code == 403


@pytest.mark.asyncio
async def test_domain_allowlist_is_case_insensitive_and_exact(monkeypatch, auth_db):
    _trusted_proxy_settings(monkeypatch, AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio")
    async with _make_client(auth_db) as client:
        upper = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "Bob@VALARIS.STUDIO"}
        )
        assert upper.status_code == 200

        subdomain = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "bob@sub.valaris.studio"}
        )
        assert subdomain.status_code == 403


@pytest.mark.asyncio
async def test_domain_allowlist_rejects_existing_user_too(monkeypatch, auth_db):
    """Policy is current, not grandfathered: a pre-existing user row does not bypass it."""
    _trusted_proxy_settings(monkeypatch)
    async with _make_client(auth_db) as client:
        first = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "old@legacy.example"}
        )
        assert first.status_code == 200  # provisioned while unrestricted

    _trusted_proxy_settings(monkeypatch, AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio")
    async with _make_client(auth_db) as client:
        blocked = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "old@legacy.example"}
        )
        assert blocked.status_code == 403


@pytest.mark.asyncio
async def test_domain_allowlist_skips_dev_mode(monkeypatch, auth_db):
    _trusted_proxy_settings(
        monkeypatch, ENV="development", AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio"
    )
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", headers={"X-User-Email": "dev@anything.example"}
        )
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_ws_domain_allowlist(monkeypatch, ws_session_factory):
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch, AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio")

    user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "mallory@evil.example"})
    )
    assert user is None

    user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio"})
    )
    assert user is not None


# ── A3: auto-provision toggle ──


@pytest.mark.asyncio
async def test_auto_provision_off_rejects_unknown_user(monkeypatch, auth_db):
    _trusted_proxy_settings(monkeypatch, AUTH_AUTO_PROVISION=False)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "new@valaris.studio"}
        )
        assert resp.status_code == 403


@pytest.mark.asyncio
async def test_auto_provision_off_allows_existing_user(monkeypatch, auth_db):
    _trusted_proxy_settings(monkeypatch)
    async with _make_client(auth_db) as client:
        assert (
            await client.get(
                "/api/workspaces", headers={PROXY_EMAIL_HEADER: "known@valaris.studio"}
            )
        ).status_code == 200

    _trusted_proxy_settings(monkeypatch, AUTH_AUTO_PROVISION=False)
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "known@valaris.studio"}
        )
        assert resp.status_code == 200


@pytest.mark.asyncio
async def test_ws_auto_provision_toggle(monkeypatch, ws_session_factory):
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch, AUTH_AUTO_PROVISION=False)
    user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "new@valaris.studio"})
    )
    assert user is None

    _trusted_proxy_settings(monkeypatch)
    user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "new@valaris.studio"})
    )
    assert user is not None

    _trusted_proxy_settings(monkeypatch, AUTH_AUTO_PROVISION=False)
    user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "new@valaris.studio"})
    )
    assert user is not None  # provisioned above, so allowed now


@pytest.mark.asyncio
async def test_domain_check_runs_before_provision_check(monkeypatch, auth_db):
    _trusted_proxy_settings(
        monkeypatch,
        AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio",
        AUTH_AUTO_PROVISION=False,
    )
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/workspaces", headers={PROXY_EMAIL_HEADER: "x@evil.example"}
        )
        assert resp.status_code == 403
        assert resp.json()["detail"] == "Email domain not allowed"


# ── A4: audit logging ──


@pytest.mark.asyncio
async def test_rejection_logs_reason_without_secrets(monkeypatch, auth_db, caplog):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    with caplog.at_level(logging.WARNING, logger="app.core.auth"):
        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Goog-IAP-JWT-Assertion": "super.secret.jwtvalue"},
            )
            assert resp.status_code == 403

    rejected = [r for r in caplog.records if "auth rejected" in r.getMessage()]
    assert rejected, "expected an auth-rejection log record"
    message = rejected[0].getMessage()
    assert "invalid_iap_jwt" in message
    assert "/api/workspaces" in message
    assert "super.secret.jwtvalue" not in caplog.text


@pytest.mark.asyncio
async def test_missing_jwt_logs_distinct_reason(monkeypatch, auth_db, caplog):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    with caplog.at_level(logging.WARNING, logger="app.core.auth"):
        async with _make_client(auth_db) as client:
            assert (await client.get("/api/workspaces")).status_code == 403
    assert "missing_iap_jwt" in caplog.text


@pytest.mark.asyncio
async def test_domain_rejection_logs_domain_only(monkeypatch, auth_db, caplog):
    _trusted_proxy_settings(monkeypatch, AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio")
    with caplog.at_level(logging.WARNING, logger="app.core.auth"):
        async with _make_client(auth_db) as client:
            await client.get(
                "/api/workspaces", headers={PROXY_EMAIL_HEADER: "mallory@evil.example"}
            )
    assert "email_domain_not_allowed" in caplog.text
    assert "evil.example" in caplog.text
    assert "mallory@" not in caplog.text  # local part never logged on failure


@pytest.mark.asyncio
async def test_provisioning_logs_info(monkeypatch, auth_db, caplog):
    _trusted_proxy_settings(monkeypatch)
    with caplog.at_level(logging.INFO, logger="app.core.auth"):
        async with _make_client(auth_db) as client:
            await client.get(
                "/api/workspaces", headers={PROXY_EMAIL_HEADER: "fresh@valaris.studio"}
            )
    provisioned = [r for r in caplog.records if "auth provisioned" in r.getMessage()]
    assert provisioned and "fresh@valaris.studio" in provisioned[0].getMessage()


@pytest.mark.asyncio
async def test_ws_rejection_logs_reason(monkeypatch, ws_session_factory, caplog):
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch, TRUSTED_PROXY_SECRET="s3cret")
    with caplog.at_level(logging.WARNING):
        user, _ = await _authenticate_ws(
            _fake_ws({PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio"})
        )
    assert user is None
    assert "invalid_proxy_secret" in caplog.text


# ── A4b: real client IP behind the load balancer ──


def _ip_request(headers: dict[str, str], peer: str | None = "10.0.0.1"):
    return SimpleNamespace(
        headers=headers, client=SimpleNamespace(host=peer) if peer else None
    )


def test_forwarded_for_used_when_behind_iap(monkeypatch):
    from app.core.auth import resolve_client_ip

    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    request = _ip_request({"X-Forwarded-For": "203.0.113.7, 35.191.0.5, 10.0.0.1"})
    assert resolve_client_ip(request) == "203.0.113.7"


def test_forwarded_for_ignored_without_trusted_verifier(monkeypatch):
    """No verifier configured → anyone can reach us directly and forge XFF."""
    from app.core.auth import resolve_client_ip

    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    request = _ip_request({"X-Forwarded-For": "1.2.3.4"})
    assert resolve_client_ip(request) == "10.0.0.1"


def test_forwarded_for_ignored_when_proxy_secret_handshake_fails(monkeypatch):
    """Trusted-proxy mode only trusts XFF from a hop that proves the secret."""
    from app.core.auth import resolve_client_ip

    _trusted_proxy_settings(monkeypatch, TRUSTED_PROXY_SECRET="s3cret")
    forged = _ip_request({"X-Forwarded-For": "1.2.3.4"})
    assert resolve_client_ip(forged) == "10.0.0.1"

    from app.core.auth import PROXY_SECRET_HEADER

    genuine = _ip_request({"X-Forwarded-For": "1.2.3.4", PROXY_SECRET_HEADER: "s3cret"})
    assert resolve_client_ip(genuine) == "1.2.3.4"


def test_forwarded_for_falls_back_to_peer_when_absent_or_blank(monkeypatch):
    from app.core.auth import resolve_client_ip

    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    assert resolve_client_ip(_ip_request({})) == "10.0.0.1"
    assert resolve_client_ip(_ip_request({"X-Forwarded-For": "  ,  "})) == "10.0.0.1"
    assert resolve_client_ip(_ip_request({}, peer=None)) == "unknown"


@pytest.mark.asyncio
async def test_rejection_log_carries_forwarded_client_ip(monkeypatch, auth_db, caplog):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    with caplog.at_level(logging.WARNING, logger="app.core.auth"):
        async with _make_client(auth_db) as client:
            resp = await client.get(
                "/api/workspaces",
                headers={"X-Forwarded-For": "203.0.113.7, 35.191.0.5"},
            )
            assert resp.status_code == 403
    assert "ip=203.0.113.7" in caplog.text


@pytest.mark.asyncio
async def test_ws_rejection_log_carries_forwarded_client_ip(
    monkeypatch, ws_session_factory, caplog
):
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch, TRUSTED_PROXY_SECRET="s3cret")
    with caplog.at_level(logging.WARNING):
        user, _ = await _authenticate_ws(
            _fake_ws(
                {
                    PROXY_EMAIL_HEADER.lower(): "bob@valaris.studio",
                    "x-forwarded-for": "203.0.113.9, 10.0.0.1",
                }
            )
        )
    assert user is None
    # handshake failed → XFF untrusted, so the peer (here: unknown) is logged
    assert "ip=203.0.113.9" not in caplog.text


def test_rate_limiter_keys_unauthed_callers_by_forwarded_ip(monkeypatch):
    """Behind a proxy every caller shares the peer IP — key on the real client."""
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)

    def key_for(xff: str) -> str:
        key, limit = limiter._get_client_key(
            SimpleNamespace(
                headers={"x-forwarded-for": xff},
                client=SimpleNamespace(host="10.0.0.9"),
                method="GET",
                url=SimpleNamespace(path="/api/health"),
            )
        )
        assert limit == UNAUTHENTICATED_LIMIT
        return key

    assert key_for("203.0.113.7, 35.191.0.5") == "ip:203.0.113.7"
    assert key_for("198.51.100.4, 35.191.0.5") == "ip:198.51.100.4"


def test_rate_limiter_ignores_forwarded_ip_without_trusted_verifier(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)
    key, _ = limiter._get_client_key(
        SimpleNamespace(
            headers={"x-forwarded-for": "1.2.3.4"},
            client=SimpleNamespace(host="10.0.0.9"),
            method="GET",
            url=SimpleNamespace(path="/api/health"),
        )
    )
    assert key == "ip:10.0.0.9"


def test_rate_limiter_login_bucket_ignores_session_cookie(monkeypatch):
    """A valid session (or any trusted header) must not raise the budget for
    password attempts — the login endpoint is always the tight per-IP bucket."""
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)
    key, limit = limiter._get_client_key(
        SimpleNamespace(
            headers={"x-user-email": "bob@valaris.studio"},
            cookies={"backplane_session": "anything"},
            client=SimpleNamespace(host="10.0.0.9"),
            method="POST",
            url=SimpleNamespace(path="/api/auth/login"),
        )
    )
    assert key == "login:10.0.0.9"
    assert limit == LOGIN_LIMIT


# ── email case-insensitive identity ──
#
# One address = one identity, regardless of casing. Every auto-provisioning
# tier must store the canonical (lowercase) form and resolve any case variant
# to the same row — otherwise `Pat@Example.com` and `pat@example.com` mint two
# users and split memberships/roles between them.


@pytest.mark.asyncio
async def test_http_auto_provision_case_variant_resolves_same_user(
    monkeypatch, auth_db
):
    from sqlalchemy import func, select

    from app.models.user import User

    _trusted_proxy_settings(monkeypatch, ENV="development")
    async with _make_client(auth_db) as client:
        first = await client.get(
            "/api/me", headers={"X-User-Email": "Pat@Example.com"}
        )
        assert first.status_code == 200
        second = await client.get(
            "/api/me", headers={"X-User-Email": "pat@example.com"}
        )
        assert second.status_code == 200

    assert first.json()["id"] == second.json()["id"]

    row_count = (
        await auth_db.execute(
            select(func.count())
            .select_from(User)
            .where(func.lower(User.email) == "pat@example.com")
        )
    ).scalar_one()
    assert row_count == 1


@pytest.mark.asyncio
async def test_http_auto_provision_stores_email_lowercase(monkeypatch, auth_db):
    from sqlalchemy import select

    from app.models.user import User

    _trusted_proxy_settings(monkeypatch, ENV="development")
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/me", headers={"X-User-Email": "Pat@Example.com"}
        )
        assert resp.status_code == 200

    stored = (await auth_db.execute(select(User))).scalars().all()
    assert [u.email for u in stored] == ["pat@example.com"]


@pytest.mark.asyncio
async def test_ws_get_or_create_case_variant_no_duplicate(
    monkeypatch, ws_session_factory
):
    from sqlalchemy import select

    from app.models.user import User
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch)
    first, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "pat@valaris.studio"})
    )
    assert first is not None

    variant, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): "Pat@VALARIS.studio"})
    )
    assert variant is not None
    assert variant.id == first.id

    async with ws_session_factory() as session:
        rows = (await session.execute(select(User))).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_ws_allowlist_accepts_padded_case_variant_like_http(
    monkeypatch, auth_db, ws_session_factory
):
    """HTTP and WS must agree on identity policy: the domain allowlist runs on
    the NORMALIZED email. A padded case variant that HTTP accepts (and
    provisions) must not be refused at the socket — the same header value
    resolves the same user on both transports."""
    from app.routers.events import _authenticate_ws

    _trusted_proxy_settings(monkeypatch, AUTH_ALLOWED_EMAIL_DOMAINS="valaris.studio")

    padded = "  Pat@VALARIS.studio  "
    async with _make_client(auth_db) as client:
        resp = await client.get("/api/me", headers={PROXY_EMAIL_HEADER: padded})
        assert resp.status_code == 200

    ws_user, _ = await _authenticate_ws(
        _fake_ws({PROXY_EMAIL_HEADER.lower(): padded})
    )
    assert ws_user is not None, "WS refused an email HTTP accepted"
    assert str(ws_user.id) == resp.json()["id"]


@pytest.mark.asyncio
async def test_http_auto_provision_strips_padded_email(monkeypatch, auth_db):
    from sqlalchemy import select

    from app.models.user import User

    _trusted_proxy_settings(monkeypatch, ENV="development")
    async with _make_client(auth_db) as client:
        resp = await client.get(
            "/api/me", headers={"X-User-Email": "  Pat@Example.com  "}
        )
        assert resp.status_code == 200

    stored = (await auth_db.execute(select(User))).scalars().all()
    assert [u.email for u in stored] == ["pat@example.com"]
