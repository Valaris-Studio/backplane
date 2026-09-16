# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from httpx import AsyncClient

import app.config as config_module


@pytest.mark.asyncio
async def test_response_carries_baseline_security_headers(client: AsyncClient):
    response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["referrer-policy"] == "no-referrer"
    assert "default-src 'none'" in response.headers["content-security-policy"]
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


@pytest.mark.asyncio
async def test_hsts_absent_in_development(client: AsyncClient):
    # Dev is the default ENV; HSTS must not force https on localhost.
    assert config_module.settings.is_development is True

    response = await client.get("/api/health")

    assert "strict-transport-security" not in response.headers


@pytest.mark.asyncio
async def test_hsts_present_in_production(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(config_module.settings, "ENV", "production")
    assert config_module.settings.is_development is False

    response = await client.get("/api/health")

    assert "strict-transport-security" in response.headers
