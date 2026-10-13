# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The pre-crypto screen runs on every IP-tier request before the bucket check,
so nothing a caller puts in a token may make it raise."""

import base64
import json
import time
from unittest.mock import patch

import pytest
from starlette.responses import PlainTextResponse

from app.config import settings as app_settings
from app.core.auth import IAP_JWT_HEADER, verified_iap_email
from app.core.iap_claims_cache import MAX_TOKEN_LENGTH, iap_jwt_is_plausible
from app.core.rate_limit import RateLimitMiddleware
from app.exceptions import ForbiddenError
from tests.core.test_rate_limit_iap_identity import _request

AUDIENCE = "/projects/1/global/backendServices/2"
IAP_ISSUER = "https://cloud.google.com/iap"


def _segment(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _token(header: dict, payload: dict) -> str:
    return f"{_segment(json.dumps(header).encode())}.{_segment(json.dumps(payload).encode())}.sig"


def _payload(**overrides) -> dict:
    return {
        "aud": AUDIENCE,
        "iss": IAP_ISSUER,
        "exp": int(time.time()) + 600,
        "email": "a@valaris.studio",
        **overrides,
    }


@pytest.fixture
def behind_iap(monkeypatch):
    monkeypatch.setattr(app_settings, "ENV", "production")
    monkeypatch.setattr(app_settings, "IAP_AUDIENCE", AUDIENCE)
    monkeypatch.setattr(app_settings, "TRUSTED_PROXY_AUTH", False)
    monkeypatch.setattr(app_settings, "FORWARDED_TRUSTED_PROXIES", "")
    monkeypatch.setattr(app_settings, "EDGE_PROXY_SECRET", "")
    return monkeypatch


def test_real_iap_token_shape_is_plausible():
    header = {"alg": "ES256", "typ": "JWT", "kid": "0oeLcQ"}
    payload = _payload(
        iat=int(time.time()),
        sub="accounts.google.com:1",
        hd="valaris.studio",
        google={"access_levels": []},
    )
    assert iap_jwt_is_plausible(_token(header, payload), AUDIENCE)


NESTING_BOMB = _segment(b"[" * 20000)


@pytest.mark.parametrize(
    "header_segment",
    [
        NESTING_BOMB,
        _segment(b'{"alg": "ES256"} trailing'),
        _segment(b"\xff\xfe"),
        "éééé",
        _segment(b"[]"),
        _segment(b"null"),
    ],
    ids=["nesting-bomb", "extra-data", "bad-utf8", "non-ascii", "list", "null"],
)
def test_hostile_segments_are_implausible_never_raise(header_segment):
    token = f"{header_segment}.{_segment(b'{}')}.sig"
    assert iap_jwt_is_plausible(token, AUDIENCE) is False


def test_oversized_token_is_rejected_before_decoding():
    header = {"alg": "ES256", "kid": "k", "pad": "x" * MAX_TOKEN_LENGTH}
    token = _token(header, _payload())
    with patch("app.core.iap_claims_cache.json.loads") as loads:
        assert iap_jwt_is_plausible(token, AUDIENCE) is False
    loads.assert_not_called()


@pytest.mark.asyncio
async def test_nesting_bomb_on_the_rate_limited_path_is_not_a_500(behind_iap):
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)

    async def ok(_request):
        return PlainTextResponse("ok")

    bomb = f"{NESTING_BOMB}.{_segment(b'{}')}.sig"
    response = await limiter.dispatch(_request({IAP_JWT_HEADER: bomb}), ok)
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_verified_iap_email_never_raises_on_a_screen_failure(behind_iap):
    with patch(
        "app.core.auth.iap_jwt_is_plausible", side_effect=RecursionError("boom")
    ):
        assert await verified_iap_email(_request({IAP_JWT_HEADER: "x.y.z"})) is None


@pytest.mark.asyncio
async def test_claims_cached_under_one_audience_are_not_reused_under_another(
    behind_iap,
):
    from app.core.auth import _extract_email_from_iap_jwt

    payload = _payload()
    token = _token({"alg": "ES256", "kid": "k"}, payload)
    with patch("app.core.auth.id_token.verify_token", return_value=payload):
        assert await verified_iap_email(_request({IAP_JWT_HEADER: token}))
    behind_iap.setattr(app_settings, "IAP_AUDIENCE", "/projects/2/other")
    with patch(
        "app.core.auth.id_token.verify_token", side_effect=ValueError("aud")
    ) as verify:
        with pytest.raises(ForbiddenError):
            await _extract_email_from_iap_jwt(_request({IAP_JWT_HEADER: token}))
    assert verify.call_count == 1


@pytest.mark.asyncio
async def test_expired_cached_token_is_reverified(behind_iap):
    from app.core.auth import _extract_email_from_iap_jwt

    exp = time.time() + 600
    payload = _payload(exp=exp)
    token = _token({"alg": "ES256", "kid": "k"}, payload)
    with patch("app.core.auth.id_token.verify_token", return_value=payload):
        await _extract_email_from_iap_jwt(_request({IAP_JWT_HEADER: token}))
    with (
        patch("app.core.iap_claims_cache.time.time", return_value=exp + 1),
        patch("app.core.auth.id_token.verify_token", side_effect=ValueError("exp")),
    ):
        with pytest.raises(ForbiddenError):
            await _extract_email_from_iap_jwt(_request({IAP_JWT_HEADER: token}))
