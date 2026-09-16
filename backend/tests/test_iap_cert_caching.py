# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card 5e00fdc3: IAP cert fetches must be cached, and verification must not
block the event loop.

`id_token.verify_token` fetches Google's public certs over HTTP on every call
unless the underlying `requests.Session` is wrapped with cachecontrol (the
certs endpoint sends cache headers — google-auth relies on the transport to
honor them; it does no caching of its own). Uncached, every IAP-authenticated
request in prod re-fetches certs; worse, the fetch — and the whole JWT
verification — runs synchronously inside the async request path, so it blocks
the event loop for every in-flight request while it happens.
"""

from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.database import get_db
from app.main import create_app


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


def _hardening_defaults(mock_settings):
    mock_settings.TRUSTED_PROXY_SECRET = ""
    mock_settings.AUTH_ALLOWED_EMAIL_DOMAINS = ""
    mock_settings.AUTH_AUTO_PROVISION = True


# ── Certs are fetched through a cached transport ──


def test_iap_cert_session_is_cachecontrol_wrapped():
    """auth.py's shared google_requests.Request must wrap a CacheControl session.

    Pins the wiring directly at the seam google-auth actually reads from: the
    module-level Request object certs are fetched through must carry a
    CacheControl-wrapped requests.Session, not a bare one. Without this,
    verify_token's underlying transport re-fetches certs on every call
    regardless of the certs endpoint's cache headers — mocking
    `id_token.verify_token` itself (as the existing IAP tests do) can't see
    this, since it never exercises the real transport.
    """
    from cachecontrol import CacheControlAdapter

    from app.core.auth import _google_request

    session = _google_request.session
    adapters = list(session.adapters.values())
    assert any(isinstance(adapter, CacheControlAdapter) for adapter in adapters), (
        "expected app.core.auth._google_request's session to be wrapped with "
        "cachecontrol.CacheControl so IAP cert fetches are cached; got a bare "
        "requests.Session"
    )


# ── Verification must not block the event loop ──


@pytest.mark.asyncio
async def test_iap_verify_runs_off_the_event_loop(auth_db):
    """The synchronous google-auth verify call must be dispatched via
    anyio.to_thread.run_sync at the async boundary, not called inline in the
    async request-handling path.
    """
    import anyio.to_thread

    to_thread_calls = []
    real_run_sync = anyio.to_thread.run_sync

    async def spy_run_sync(func, *args, **kwargs):
        to_thread_calls.append(func)
        return await real_run_sync(func, *args, **kwargs)

    with (
        patch("app.core.auth.settings") as mock_settings,
        patch("app.core.auth.id_token.verify_token") as mock_verify,
        patch("anyio.to_thread.run_sync", side_effect=spy_run_sync),
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

    assert to_thread_calls, (
        "expected the IAP JWT verification to be dispatched through "
        "anyio.to_thread.run_sync; it was called inline on the event loop instead"
    )


# ── The WebSocket IAP path must share the same cached, off-loop verification ──


@pytest_asyncio.fixture
async def ws_session_factory(db_engine, monkeypatch):
    import app.routers.events as events_module

    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    monkeypatch.setattr(events_module, "async_session", session_factory)
    return session_factory


def _fake_ws(headers: dict[str, str]):
    from types import SimpleNamespace

    return SimpleNamespace(headers=headers, query_params={})


@pytest.mark.asyncio
async def test_ws_iap_verify_runs_off_the_event_loop(monkeypatch, ws_session_factory):
    """`_authenticate_ws`'s IAP branch must go through the same shared,
    cached, off-loop verification as the HTTP path — not its own inline
    `google_requests.Request()` + synchronous `verify_token` call.
    """
    import anyio.to_thread

    from app.config import settings as app_settings
    from app.routers.events import _authenticate_ws

    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/123/x/456")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "AUTH_ALLOWED_EMAIL_DOMAINS", "")
    monkeypatch.setattr(app_settings, "AUTH_AUTO_PROVISION", True)

    to_thread_calls = []
    real_run_sync = anyio.to_thread.run_sync

    async def spy_run_sync(func, *args, **kwargs):
        to_thread_calls.append(func)
        return await real_run_sync(func, *args, **kwargs)

    with (
        patch("app.core.auth.id_token.verify_token") as mock_verify,
        patch("anyio.to_thread.run_sync", side_effect=spy_run_sync),
    ):
        mock_verify.return_value = {"email": "carol@valaris.studio", "sub": "123"}

        user, _agent_id = await _authenticate_ws(
            _fake_ws({"x-goog-iap-jwt-assertion": "valid.jwt.token"})
        )

    assert user is not None and user.email == "carol@valaris.studio"
    assert to_thread_calls, (
        "expected the WS IAP JWT verification to be dispatched through "
        "anyio.to_thread.run_sync; it was called inline on the event loop instead"
    )
