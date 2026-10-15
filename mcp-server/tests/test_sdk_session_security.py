# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Bounded HTTP regressions for SDK session retention; no backend tool calls."""
import math
from copy import deepcopy

import anyio
import httpx
import pytest

from valaris_mcp import client as client_module
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio
HEADERS = {"Accept": "application/json, text/event-stream"}
INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "session-security-fixture", "version": "1"},
    },
}


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def http_server(monkeypatch):
    # Retain Backplane's real app/lifespan and SDK transport. JSON responses
    # keep each ASGI request finite without a live SSE connection or socket.
    settings = deepcopy(mcp.settings)
    settings.json_response = True
    monkeypatch.setattr(mcp, "settings", settings)
    monkeypatch.setattr(mcp, "_session_manager", None)
    monkeypatch.setattr(client_module, "API_BASE_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(client_module, "API_KEY", "vlr_synthetic_session_security")
    monkeypatch.setattr(client_module, "IAP_AUDIENCE", "")
    app = mcp.streamable_http_app()
    manager = mcp.session_manager
    with anyio.fail_after(8):
        async with manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://127.0.0.1:8000",
                headers=HEADERS,
            ) as client:
                yield client, manager


async def initialize(client):
    response = await client.post("/mcp", json=INITIALIZE)
    assert response.status_code == 200, response.text
    assert response.json()["result"]["serverInfo"]["name"] == "Valaris"
    session = response.headers["mcp-session-id"]
    notification = await client.post(
        "/mcp",
        headers={"mcp-session-id": session},
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
    )
    assert notification.status_code == 202, notification.text
    return session


async def test_stateful_http_has_finite_default_session_limits(http_server):
    _, manager = http_server
    assert manager.stateless is False
    idle = getattr(manager, "session_idle_timeout", None)
    capacity = getattr(manager, "max_sessions", None)
    assert idle is not None and math.isfinite(idle) and idle > 0, idle
    assert isinstance(capacity, int) and 0 < capacity < math.inf, capacity


async def test_http_session_capacity_refuses_only_new_sessions(http_server):
    client, manager = http_server
    # Configure the actual manager, not its admission implementation. The old
    # SDK accepts this attribute but ignores it, admitting a third session.
    manager.max_sessions = 2
    first = await initialize(client)
    await initialize(client)
    refused = await client.post("/mcp", json=INITIALIZE)
    assert refused.status_code == 503, refused.text
    assert "mcp-session-id" not in refused.headers
    listed = await client.post(
        "/mcp", headers={"mcp-session-id": first},
        json={"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
    )
    assert listed.status_code == 200, listed.text
    assert "create_note" in {tool["name"] for tool in listed.json()["result"]["tools"]}


async def test_http_delete_discards_session_and_releases_capacity(http_server):
    client, manager = http_server
    manager.max_sessions = 1
    session = await initialize(client)
    deleted = await client.delete("/mcp", headers={"mcp-session-id": session})
    assert deleted.status_code == 200, deleted.text
    assert session not in manager._server_instances, "terminated session remains retained"
    replacement = await initialize(client)
    assert replacement != session
    stale = await client.post(
        "/mcp", headers={"mcp-session-id": session},
        json={"jsonrpc": "2.0", "id": 3, "method": "ping"},
    )
    assert stale.status_code == 404, stale.text


async def test_http_refused_opening_request_does_not_retain_session(http_server):
    client, manager = http_server
    manager.max_sessions = 1
    refused = await client.post(
        "/mcp", headers={"Accept": "text/plain"}, json=INITIALIZE,
    )
    assert refused.status_code == 406, refused.text
    assert not manager._server_instances, "refused opening request retains session state"
    await initialize(client)


async def test_http_idle_session_expires_and_new_session_can_initialize(http_server):
    client, manager = http_server
    manager.session_idle_timeout = 0.05
    session = await initialize(client)
    with anyio.fail_after(2):
        while session in manager._server_instances:
            await anyio.sleep(0.01)
    stale = await client.post(
        "/mcp", headers={"mcp-session-id": session},
        json={"jsonrpc": "2.0", "id": 4, "method": "ping"},
    )
    assert stale.status_code == 404, stale.text
    assert await initialize(client) != session
