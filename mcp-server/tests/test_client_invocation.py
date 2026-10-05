# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import uuid

import httpx
import pytest

from valaris_mcp.client import ValarisClient

pytestmark = pytest.mark.anyio


async def test_concurrent_request_headers_are_local_and_preserve_explicit_headers():
    from valaris_mcp.client import current_invocation_id

    received = []

    async def respond(request):
        await asyncio.sleep(0)
        received.append(request)
        return httpx.Response(200, json={})

    api = ValarisClient()
    await api._http.aclose()
    api._http = httpx.AsyncClient(
        transport=httpx.MockTransport(respond),
        base_url="http://test",
        headers={"Authorization": "Bearer synthetic"},
    )

    async def one(identity):
        token = current_invocation_id.set(identity)
        try:
            await api.get("/one", headers={"X-Session": identity})
        finally:
            current_invocation_id.reset(token)

    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    try:
        await asyncio.gather(*(one(identity) for identity in ids))
        await api.get("/outside")
    finally:
        await api.close()
    for request in received[:2]:
        assert request.headers["X-Backplane-Invocation-ID"] == request.headers["X-Session"]
        assert request.headers["Authorization"] == "Bearer synthetic"
    assert "X-Backplane-Invocation-ID" not in received[-1].headers
    assert current_invocation_id.get() is None
