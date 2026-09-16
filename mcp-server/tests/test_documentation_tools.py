# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pytest
from valaris_mcp.tools.documentation import list_documentation, read_documentation


@pytest.mark.anyio
async def test_reads_connected_platform_version_without_local_fallback(ctx, mock_client):
    mock_client.get.return_value = {"version": "platform-version", "sections": []}
    result = json.loads(await list_documentation(locale="es", limit=3, offset=2, ctx=ctx))
    assert result["version"] == "platform-version"
    mock_client.get.assert_awaited_with("/documentation", locale="es", limit=3, offset=2)
    await read_documentation(
        "custom-roles", locale="pt-BR", version="platform-version", offset=100, limit=500, ctx=ctx
    )
    mock_client.get.assert_awaited_with(
        "/documentation/custom-roles",
        locale="pt-BR",
        version="platform-version",
        offset=100,
        limit=500,
    )


@pytest.mark.anyio
@pytest.mark.parametrize("status", [401, 403, 404, 409, 503])
async def test_platform_failures_are_not_replaced_by_bundled_docs(ctx, mock_client, status):
    import httpx

    response = httpx.Response(
        status,
        json={"detail": "Platform documentation unavailable"},
        request=httpx.Request("GET", "https://example.test/api/documentation"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "failed", request=response.request, response=response
    )
    result = json.loads(await read_documentation("custom-roles", version="old", ctx=ctx))
    assert result["error"] is True
    assert result["status"] == status
    assert "markdown" not in result


@pytest.mark.anyio
async def test_real_http_client_encodes_query_parameters(ctx):
    import httpx
    from valaris_mcp.client import ValarisClient

    client = ValarisClient()
    await client.close()
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={"version": "current", "markdown": "# Docs"})

    client._http = httpx.AsyncClient(
        base_url="https://example.test", transport=httpx.MockTransport(respond)
    )
    ctx.request_context.lifespan_context.client = client
    try:
        result = json.loads(
            await read_documentation(
                "custom-roles", locale="es", version="current", offset=5, limit=10, ctx=ctx
            )
        )
        assert result["version"] == "current"
        assert requests[0].url.path == "/api/documentation/custom-roles"
        assert dict(requests[0].url.params) == {
            "locale": "es",
            "version": "current",
            "offset": "5",
            "limit": "10",
        }
    finally:
        await client.close()
