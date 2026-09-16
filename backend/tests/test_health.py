# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_health_endpoint(client: AsyncClient):
    response = await client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"


@pytest.mark.asyncio
async def test_health_reports_event_bus(client: AsyncClient):
    # Additive observability (Fix 6): the probe surfaces the bus backend and,
    # for postgres, its LISTEN liveness. Tests run on the memory default, so
    # backend is "memory" and there is no listener -> listener_connected null.
    response = await client.get("/api/health")
    body = response.json()
    assert body["event_bus"]["backend"] == "memory"
    assert body["event_bus"]["listener_connected"] is None
