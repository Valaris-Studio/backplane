# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Behind IAP the authed rate-limit tier needs a verified IAP JWT, not a header.

The backend's run.app URL (and the /api/companion bypass) is reachable without
IAP, so X-Goog-Authenticated-User-Email there is whatever the caller typed: a
caller rotating it must not mint a fresh 300/min bucket per request.
"""

import base64
import json
import time
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.requests import Request
from starlette.responses import PlainTextResponse

from app.config import settings as app_settings
from app.core.auth import IAP_JWT_FALLBACK_HEADER, IAP_JWT_HEADER
from app.core.rate_limit import (
    AUTHENTICATED_LIMIT,
    UNAUTHENTICATED_LIMIT,
    RateLimitMiddleware,
)

CLIENT = "203.0.113.7"
IAP_EMAIL_HEADER = "x-goog-authenticated-user-email"


def _request(
    headers: dict[str, str], path: str = "/api/health", method: str = "GET"
) -> Request:
    raw = [(b"x-forwarded-for", CLIENT.encode())]
    raw += [(k.lower().encode(), v.encode()) for k, v in headers.items()]
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "headers": raw,
            "client": ("10.0.0.1", 1234),
            "query_string": b"",
        }
    )


@pytest.fixture
def behind_iap(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "/projects/1/x/2")
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_settings, "EDGE_PROXY_SECRET", "")


@pytest.fixture
def limiter():
    return RateLimitMiddleware(app=lambda scope, receive, send: None)


@pytest.mark.asyncio
async def test_unverified_iap_email_header_gets_the_ip_tier(behind_iap, limiter):
    keys = set()
    for n in range(3):
        key, limit = await limiter._resolve_client_key(
            _request({IAP_EMAIL_HEADER: f"accounts.google.com:user{n}@x.com"})
        )
        assert limit == UNAUTHENTICATED_LIMIT
        keys.add(key)
    assert keys == {f"ip:{CLIENT}"}


@pytest.mark.asyncio
async def test_unverified_dev_email_header_gets_the_ip_tier(behind_iap, limiter):
    key, limit = await limiter._resolve_client_key(
        _request({"x-user-email": "bob@valaris.studio"})
    )
    assert (key, limit) == (f"ip:{CLIENT}", UNAUTHENTICATED_LIMIT)


@pytest.mark.asyncio
async def test_invalid_iap_jwt_gets_the_ip_tier(behind_iap, limiter):
    with patch(
        "app.core.auth.id_token.verify_token", side_effect=ValueError("bad jwt")
    ):
        key, limit = await limiter._resolve_client_key(
            _request(
                {
                    IAP_JWT_HEADER: "forged.jwt.value",
                    IAP_EMAIL_HEADER: "accounts.google.com:bob@valaris.studio",
                }
            )
        )
    assert (key, limit) == (f"ip:{CLIENT}", UNAUTHENTICATED_LIMIT)


@pytest.mark.asyncio
@pytest.mark.parametrize("jwt_header", [IAP_JWT_HEADER, IAP_JWT_FALLBACK_HEADER])
async def test_verified_iap_jwt_earns_the_authed_tier_by_its_email(
    behind_iap, limiter, jwt_header
):
    with patch(
        "app.core.auth.id_token.verify_token",
        return_value={"email": "Bob@Valaris.Studio"},
    ) as verify:
        key, limit = await limiter._resolve_client_key(
            _request(
                {
                    jwt_header: _iap_shaped_jwt(nonce=jwt_header),
                    IAP_EMAIL_HEADER: "accounts.google.com:mallory@x.com",
                }
            )
        )
    assert (key, limit) == ("user:bob@valaris.studio", AUTHENTICATED_LIMIT)
    assert verify.call_args.kwargs["audience"] == "/projects/1/x/2"


@pytest.mark.asyncio
async def test_iap_jwt_is_not_verified_for_ip_keyed_endpoints(behind_iap, limiter):
    with patch("app.core.auth.id_token.verify_token") as verify:
        key, _ = await limiter._resolve_client_key(
            _request(
                {IAP_JWT_HEADER: "signed.jwt.value"},
                path="/api/auth/login",
                method="POST",
            )
        )
    assert key == f"login:{CLIENT}"
    verify.assert_not_called()


@pytest.mark.asyncio
async def test_dev_mode_still_trusts_the_email_header(monkeypatch, limiter):
    monkeypatch.setattr(app_settings, "ENV", "development")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", "")
    key, limit = await limiter._resolve_client_key(
        _request({"x-user-email": "bob@valaris.studio"})
    )
    assert (key, limit) == ("user:bob@valaris.studio", AUTHENTICATED_LIMIT)


# ── verification cost: a throttled caller can't buy crypto per request ──


def _iap_shaped_jwt(
    *,
    exp_in: float = 600,
    aud: str = "/projects/1/x/2",
    alg: str = "ES256",
    nonce: str = "n",
) -> str:
    """Structurally a real IAP JWT; the signature is junk (verify is mocked)."""

    def segment(value: dict) -> str:
        raw = json.dumps(value).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()

    header = segment({"alg": alg, "kid": "kid-1", "typ": "JWT"})
    payload = segment(
        {
            "aud": aud,
            "iss": "https://cloud.google.com/iap",
            "exp": time.time() + exp_in,
            "email": "bob@valaris.studio",
            "nonce": nonce,
        }
    )
    return f"{header}.{payload}.c2lnbmF0dXJl"


def _claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


@pytest.fixture
def full_ip_bucket(limiter):
    limiter._requests[f"ip:{CLIENT}"] = [time.time()] * UNAUTHENTICATED_LIMIT
    return limiter


@pytest.fixture
def empty_claims_cache():
    from app.core.auth import clear_verified_iap_claims_cache

    clear_verified_iap_claims_cache()
    yield
    clear_verified_iap_claims_cache()


async def _throttled(_request):
    raise AssertionError("should have been throttled")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "make_token",
    [
        lambda: "a.b.c",
        lambda: "not-a-jwt",
        lambda: _iap_shaped_jwt(exp_in=-60),
        lambda: _iap_shaped_jwt(aud="/projects/9/other/9"),
        lambda: _iap_shaped_jwt(alg="none"),
    ],
    # Built at run time with stable ids: exp depends on the clock, and xdist
    # workers must collect identical test ids.
    ids=["three-junk-segments", "not-a-jwt", "expired", "other-audience", "alg-none"],
)
async def test_throttled_caller_with_implausible_jwt_gets_no_verification(
    behind_iap, full_ip_bucket, empty_claims_cache, make_token
):
    token = make_token()
    with patch(
        "app.core.auth.id_token.verify_token", side_effect=ValueError("bad")
    ) as verify:
        for _ in range(20):
            response = await full_ip_bucket.dispatch(
                _request({IAP_JWT_HEADER: token}), _throttled
            )
            assert response.status_code == 429
    assert verify.call_count == 0


@pytest.mark.asyncio
async def test_repeated_valid_jwt_is_verified_once(
    behind_iap, limiter, empty_claims_cache
):
    token = _iap_shaped_jwt(nonce="repeat")
    with patch(
        "app.core.auth.id_token.verify_token", return_value=_claims(token)
    ) as verify:
        for _ in range(5):
            key, _ = await limiter._resolve_client_key(
                _request({IAP_JWT_HEADER: token})
            )
            assert key == "user:bob@valaris.studio"
    assert verify.call_count == 1


@pytest.mark.asyncio
async def test_cached_claims_expire_with_the_token(
    behind_iap, limiter, empty_claims_cache, monkeypatch
):
    from app.core import iap_claims_cache

    token = _iap_shaped_jwt(exp_in=30, nonce="expiring")
    with patch(
        "app.core.auth.id_token.verify_token", return_value=_claims(token)
    ) as verify:
        await limiter._resolve_client_key(_request({IAP_JWT_HEADER: token}))
        later = time.time() + 31
        monkeypatch.setattr(iap_claims_cache.time, "time", lambda: later)
        key, _ = await limiter._resolve_client_key(_request({IAP_JWT_HEADER: token}))
    assert key == f"ip:{CLIENT}"
    assert verify.call_count == 1


@pytest.mark.asyncio
async def test_web_users_sharing_a_full_ip_bucket_keep_their_user_bucket(
    behind_iap, full_ip_bucket, empty_claims_cache
):
    """Before EDGE_PROXY_SECRET, every nginx-path caller resolves to the
    frontend's egress IP; a full ip:E bucket must not throttle JWT holders."""
    token = _iap_shaped_jwt(nonce="web-user")

    async def ok(_request):
        return PlainTextResponse("ok")

    with patch("app.core.auth.id_token.verify_token", return_value=_claims(token)):
        response = await full_ip_bucket.dispatch(_request({IAP_JWT_HEADER: token}), ok)
    assert response.status_code == 200
    assert response.headers["x-ratelimit-limit"] == str(AUTHENTICATED_LIMIT)


@pytest_asyncio.fixture
async def auth_db(db_engine):
    session_factory = async_sessionmaker(
        db_engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        yield session


@pytest.mark.asyncio
async def test_auth_reuses_the_limiters_verification(
    behind_iap, auth_db, empty_claims_cache
):
    """One request through the app verifies its IAP JWT once, not per layer —
    even for claims the cross-request cache can't hold (no exp)."""
    from app.database import get_db
    from app.main import create_app

    app = create_app()

    async def override_get_db():
        yield auth_db

    app.dependency_overrides[get_db] = override_get_db
    token = _iap_shaped_jwt(nonce="one-request")
    uncacheable = {k: v for k, v in _claims(token).items() if k != "exp"}
    with patch(
        "app.core.auth.id_token.verify_token", return_value=uncacheable
    ) as verify:
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.get(
                "/api/workspaces", headers={IAP_JWT_HEADER: token}
            )
    assert response.status_code == 200
    assert verify.call_count == 1
