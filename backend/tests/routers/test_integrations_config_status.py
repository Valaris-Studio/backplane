# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Public config-status endpoint — frontend uses this to gate the
"Connect GitHub" CTA so unconfigured platforms don't surface a 503 on click.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app import config as _config
from app.main import create_app


@pytest.fixture
def _saved_oauth_settings():
    s = _config.settings
    snapshot = (
        s.GITHUB_OAUTH_CLIENT_ID,
        s.GITHUB_OAUTH_CLIENT_SECRET,
        s.OAUTH_STATE_SIGNING_KEY,
        s.INTEGRATIONS_TOKEN_KEY,
    )
    yield
    (
        s.GITHUB_OAUTH_CLIENT_ID,
        s.GITHUB_OAUTH_CLIENT_SECRET,
        s.OAUTH_STATE_SIGNING_KEY,
        s.INTEGRATIONS_TOKEN_KEY,
    ) = snapshot


async def _get(transport):
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/api/integrations/config-status")


@pytest.mark.asyncio
async def test_config_status_reports_configured_when_all_env_vars_set(
    _saved_oauth_settings,
):
    s = _config.settings
    s.GITHUB_OAUTH_CLIENT_ID = "Ov23li_test"
    s.GITHUB_OAUTH_CLIENT_SECRET = "ghs_test"
    s.OAUTH_STATE_SIGNING_KEY = "x" * 32
    # INTEGRATIONS_TOKEN_KEY is set by the autouse session fixture in conftest
    transport = ASGITransport(app=create_app())

    response = await _get(transport)

    assert response.status_code == 200
    assert response.json() == {
        "github_oauth_configured": True,
        "token_storage_configured": True,
    }


@pytest.mark.asyncio
async def test_config_status_reports_not_configured_when_client_id_missing(
    _saved_oauth_settings,
):
    s = _config.settings
    s.GITHUB_OAUTH_CLIENT_ID = ""
    s.GITHUB_OAUTH_CLIENT_SECRET = "ghs_test"
    s.OAUTH_STATE_SIGNING_KEY = "x" * 32
    transport = ASGITransport(app=create_app())

    response = await _get(transport)

    assert response.json() == {
        "github_oauth_configured": False,
        # PAT storage only needs the Fernet key, which IS set (conftest) —
        # a missing OAuth app must not disable the "Add token" path too.
        "token_storage_configured": True,
    }


@pytest.mark.asyncio
async def test_config_status_token_storage_needs_only_the_fernet_key(
    _saved_oauth_settings,
):
    # Frontend gates "Add token" on this flag the same way it gates
    # "Connect GitHub" on github_oauth_configured: clicking would 503.
    s = _config.settings
    s.INTEGRATIONS_TOKEN_KEY = ""
    transport = ASGITransport(app=create_app())

    response = await _get(transport)

    body = response.json()
    assert body["token_storage_configured"] is False
    assert body["github_oauth_configured"] is False


@pytest.mark.asyncio
async def test_config_status_is_public_no_auth_header_required(
    _saved_oauth_settings,
):
    # Endpoint is intentionally unauthenticated — response is binary platform
    # config, no per-tenant data, no secrets.
    transport = ASGITransport(app=create_app())

    response = await _get(transport)

    assert response.status_code == 200
    assert "github_oauth_configured" in response.json()
