# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A trailing slash is an unknown route, answered before and without auth.

Starlette's redirect_slashes used to 307 `…/boards/` to `…/boards` for every
route before any auth ran — a route-existence oracle across the whole API, with
the proxy's http scheme in Location. No route is declared with a trailing slash
and no client sends one, so the slashed form is now the plain 404.
"""

import re
import uuid
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from starlette.routing import Route

from app.main import create_app

PATH_PARAM = re.compile(r"\{[^}]+\}")
STORAGE_KEY = (
    "7b779090-29c6-4d37-953f-3edebda2b310/3f1c2a4e-9b8d-4c7e-a6f5-0d1e2c3b4a59/a.png"
)


@pytest_asyncio.fixture
async def anonymous_client():
    app = create_app()
    with patch("app.core.auth.settings") as auth_settings:
        auth_settings.is_development = False
        auth_settings.IAP_AUDIENCE = ""
        auth_settings.TRUSTED_PROXY_AUTH = False
        auth_settings.LOCAL_AUTH_ENABLED = False
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="https://test") as client:
            yield client


async def _unknown_route(client: AsyncClient, method: str = "GET"):
    return await client.request(method, f"/api/no-such-route-{uuid.uuid4().hex}")


def _slashed_routes() -> list[tuple[str, str]]:
    probes = set()
    for route in create_app().routes:
        # A path convertor legitimately accepts a slash inside its key.
        if not isinstance(route, Route) or "path}" in route.path:
            continue
        if route.path.endswith("/"):
            continue
        method = sorted(route.methods - {"HEAD"})[0]
        probes.add((method, PATH_PARAM.sub("x", route.path) + "/"))
    return sorted(probes)


SLASHED_ROUTES = _slashed_routes()


def test_slash_probe_covers_the_api():
    assert len(SLASHED_ROUTES) > 100
    assert ("GET", "/api/workspaces/x/boards/") in SLASHED_ROUTES


async def test_every_route_with_a_trailing_slash_is_an_unknown_route(
    anonymous_client, monkeypatch
):
    monkeypatch.setattr(
        "app.core.rate_limit.UNAUTHENTICATED_LIMIT", 10 * len(SLASHED_ROUTES)
    )
    mismatches = []
    for method, path in SLASHED_ROUTES:
        reference = await _unknown_route(anonymous_client, method)
        response = await anonymous_client.request(method, path)
        if (response.status_code, response.content) != (
            reference.status_code,
            reference.content,
        ):
            mismatches.append(
                (method, path, response.status_code, response.headers.get("location"))
            )
    assert mismatches == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/local-storage/download"),
        ("GET", "/api/local-storage/download/"),
        ("PUT", "/api/local-storage/upload"),
        ("PUT", "/api/local-storage/upload/"),
    ],
)
async def test_local_storage_without_a_key_is_an_unknown_route(
    anonymous_client, method, path
):
    reference = await _unknown_route(anonymous_client, method)

    response = await anonymous_client.request(method, path)

    assert reference.status_code == 404
    assert response.status_code == 404, response.headers.get("location")
    assert "location" not in response.headers
    assert response.content == reference.content


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", f"/api/local-storage/download/{STORAGE_KEY}"),
        ("PUT", f"/api/local-storage/upload/{STORAGE_KEY}"),
    ],
)
async def test_local_storage_with_a_key_still_reaches_auth(
    anonymous_client, method, path
):
    response = await anonymous_client.request(method, path)

    assert response.status_code == 403
    assert response.json()["error_code"] == "authentication_required"
