# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Media GETs spend their own per-identity budget (owner Q3).

Opening one image-heavy note issues a request per image; on the shared
300/min API budget that would starve (and be starved by) ordinary API calls.
"""

from types import SimpleNamespace

import pytest

from app.config import settings
from app.core.rate_limit import (
    API_KEY_LIMIT,
    AUTHENTICATED_LIMIT,
    MEDIA_LIMIT,
    UNAUTHENTICATED_LIMIT,
    RateLimitMiddleware,
)

OBJECT_ID = "33333333-3333-4333-8333-333333333333"


def _request(path: str, *, method: str = "GET", headers: dict | None = None):
    return SimpleNamespace(
        headers=headers or {"x-user-email": "bob@valaris.studio"},
        cookies={},
        client=SimpleNamespace(host="10.0.0.9"),
        method=method,
        url=SimpleNamespace(path=path),
    )


@pytest.fixture
def limiter(monkeypatch):
    monkeypatch.setattr(settings, "ENV", "development")
    return RateLimitMiddleware(app=lambda scope, receive, send: None)


@pytest.mark.parametrize(
    "path",
    [
        f"/api/workspaces/acme/media/{OBJECT_ID}/shot.png",
        f"/api/workspaces/acme/resources/{OBJECT_ID}/content",
    ],
)
def test_media_get_uses_separate_bucket_for_same_identity(limiter, path):
    media_key, media_limit = limiter._get_client_key(_request(path))
    api_key, api_limit = limiter._get_client_key(_request("/api/workspaces/acme/boards"))

    assert media_limit == MEDIA_LIMIT == 600
    assert api_limit == AUTHENTICATED_LIMIT
    assert media_key == f"media:{api_key}"


def test_media_bucket_applies_to_api_keys(limiter):
    headers = {"authorization": "Bearer vlr_abcdefghijklmnopqrstuvwxyz"}
    key, limit = limiter._get_client_key(
        _request(f"/api/workspaces/acme/media/{OBJECT_ID}/a.png", headers=headers)
    )

    assert key.startswith("media:apikey:")
    assert limit == MEDIA_LIMIT
    assert MEDIA_LIMIT > API_KEY_LIMIT


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/api/workspaces/acme/media/upload-url"),
        ("GET", f"/api/workspaces/acme/resources/{OBJECT_ID}/download-url"),
        ("GET", f"/api/workspaces/acme/resources/{OBJECT_ID}"),
        ("DELETE", f"/api/workspaces/acme/media/{OBJECT_ID}/a.png"),
    ],
)
def test_non_media_reads_stay_on_api_bucket(limiter, method, path):
    key, limit = limiter._get_client_key(_request(path, method=method))

    assert not key.startswith("media:")
    assert limit == AUTHENTICATED_LIMIT


def test_unauthenticated_media_requests_get_no_bigger_budget(monkeypatch):
    monkeypatch.setattr(settings, "ENV", "production")
    monkeypatch.setattr(settings, "IAP_AUDIENCE", "")
    monkeypatch.setattr(settings, "TRUSTED_PROXY_AUTH", False)
    limiter = RateLimitMiddleware(app=lambda scope, receive, send: None)

    key, limit = limiter._get_client_key(
        _request(f"/api/workspaces/acme/media/{OBJECT_ID}/a.png", headers={})
    )

    assert key == "ip:10.0.0.9"
    assert limit == UNAUTHENTICATED_LIMIT


async def test_media_bucket_is_independent_of_api_bucket(limiter):
    async def call_next(request):
        return SimpleNamespace(headers={})

    api = _request("/api/workspaces/acme/boards")
    media = _request(f"/api/workspaces/acme/media/{OBJECT_ID}/a.png")
    for _ in range(AUTHENTICATED_LIMIT):
        await limiter.dispatch(api, call_next)

    assert (await limiter.dispatch(api, call_next)).status_code == 429
    assert getattr(await limiter.dispatch(media, call_next), "status_code", 200) == 200
