# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""An incomplete media URL is an unknown route, before and without auth.

`/{object_id}/{filename:path}` used to match an EMPTY filename, so Starlette's
redirect_slashes answered `GET …/media/<id>` with a 307 to `…/media/<id>/`
before any auth ran (and with the proxy's http scheme in Location). Both forms
must be the plain unknown-route 404.
"""

import uuid
from unittest.mock import patch

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

from app.main import create_app

OBJECT_ID = "7b779090-29c6-4d37-953f-3edebda2b310"


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


async def _unknown_route(client: AsyncClient):
    return await client.get(f"/api/workspaces/x/no-such-route-{uuid.uuid4().hex}")


@pytest.mark.parametrize(
    "path",
    [
        f"/api/workspaces/x/media/{OBJECT_ID}",
        f"/api/workspaces/x/media/{OBJECT_ID}/",
        "/api/workspaces/x/media/whatever",
        "/api/workspaces/x/media/whatever/",
    ],
)
async def test_media_path_without_filename_is_unknown_route(anonymous_client: AsyncClient, path: str):
    reference = await _unknown_route(anonymous_client)

    resp = await anonymous_client.get(path)

    assert reference.status_code == 404
    assert resp.status_code == 404, resp.headers.get("location")
    assert "location" not in resp.headers
    assert resp.json() == reference.json()


async def test_media_path_with_filename_still_reaches_auth(anonymous_client: AsyncClient):
    resp = await anonymous_client.get(f"/api/workspaces/x/media/{OBJECT_ID}/a.png")

    assert resp.status_code == 403
    assert resp.json()["error_code"] == "authentication_required"


async def test_resource_content_route_reaches_auth_without_redirect(anonymous_client: AsyncClient):
    """`/content` is a fixed segment, so it has no empty-match hole: the
    request reaches auth directly. (A trailing `/content/` still gets the
    app-wide redirect_slashes 307, like every route; out of scope here.)"""
    resp = await anonymous_client.get(f"/api/workspaces/x/resources/{OBJECT_ID}/content")

    assert resp.status_code == 403
    assert "location" not in resp.headers
