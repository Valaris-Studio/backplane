# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A 0.9 client against backends that cannot record invocations: an older
self-hosted backend without the endpoint (404/405), or one that fails (5xx).
Tools must answer exactly as they would without tracking, and the recorder
must back off instead of posting on every call."""

import json
from types import SimpleNamespace

import anyio
import httpx
import pytest

from valaris_mcp.client import ValarisClient
from valaris_mcp.server import install_tracking
from valaris_mcp.tracking import InvocationRecorder

pytestmark = pytest.mark.anyio

WORKSPACES = [{"slug": "acme"}]
RECORDING_PATH = "/api/me/mcp-invocations"


def backend(recording_answer):
    requests: list[httpx.Request] = []

    async def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == RECORDING_PATH:
            return await recording_answer(request)
        if request.url.path == "/api/workspaces":
            return httpx.Response(200, json=WORKSPACES)
        return httpx.Response(404, json={"detail": "Not Found"})

    return respond, requests


async def real_client(respond) -> ValarisClient:
    api = ValarisClient()
    await api._http.aclose()
    api._http = httpx.AsyncClient(
        transport=httpx.MockTransport(respond), base_url="http://test"
    )
    return api


def tracked_tool(api, recorder):
    async def list_workspaces(name, arguments, **kwargs):
        return json.dumps(await api.get("/workspaces"))

    server = SimpleNamespace(_tool_manager=SimpleNamespace(call_tool=list_workspaces))
    install_tracking(server, recorder)
    return server._tool_manager.call_tool


async def call_repeatedly(respond, calls=5, **recorder_options):
    api = await real_client(respond)
    recorder = InvocationRecorder(api, server_instance_id="compat", **recorder_options)
    try:
        async with recorder.running():
            call_tool = tracked_tool(api, recorder)
            results = [await call_tool("list_workspaces", {}) for _ in range(calls)]
            await recorder.flush()
    finally:
        await api.close()
    return results, recorder.health()


def recording_posts(requests):
    return [request for request in requests if request.url.path == RECORDING_PATH]


@pytest.mark.parametrize("status", [404, 405])
async def test_backend_without_the_endpoint_leaves_tools_untouched_and_stops_posting(status):
    async def missing(request):
        # An older backend's own 404/405 body, not JSON the client expects.
        return httpx.Response(status, text="Not Found")

    respond, requests = backend(missing)
    results, health = await call_repeatedly(respond)

    assert [json.loads(result) for result in results] == [WORKSPACES] * 5
    assert len(recording_posts(requests)) == 1
    assert health["circuit_open"] is True
    assert health["recorded"] == 0
    assert health["unconfirmed"] == 5


async def test_failing_backend_leaves_tools_untouched_and_bounds_each_attempt():
    async def failing(request):
        return httpx.Response(500, json={"detail": "boom"})

    respond, requests = backend(failing)
    results, health = await call_repeatedly(respond, calls=3)

    assert [json.loads(result) for result in results] == [WORKSPACES] * 3
    # At most two posts per outcome; a 5xx may heal, so no breaker.
    assert len(recording_posts(requests)) == 6
    assert health["circuit_open"] is False
    assert health["unconfirmed"] == 3
    assert health["last_error"] == "http_500"


async def test_hanging_recording_endpoint_never_delays_the_tool():
    async def hang(request):
        await anyio.sleep_forever()

    respond, _ = backend(hang)
    with anyio.fail_after(2):
        results, health = await call_repeatedly(respond, calls=2, record_timeout=0.05)

    assert [json.loads(result) for result in results] == [WORKSPACES] * 2
    assert health["unconfirmed"] == 2
    assert health["last_error"] == "timeout"


async def test_tool_requests_carry_the_invocation_id_the_backend_may_ignore():
    async def acknowledge(request):
        return httpx.Response(200, json={"id": json.loads(request.content)["id"]})

    respond, requests = backend(acknowledge)
    _, health = await call_repeatedly(respond, calls=1)

    tool_request = next(r for r in requests if r.url.path == "/api/workspaces")
    recorded = json.loads(recording_posts(requests)[0].content)
    assert tool_request.headers["X-Backplane-Invocation-ID"] == recorded["id"]
    assert health["recorded"] == 1
