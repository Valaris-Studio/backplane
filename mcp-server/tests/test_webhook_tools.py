# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for the workspace-scoped webhook MCP tools (card b2df094d).

MCP shipped with only create/list, so an agent could register a webhook it
could never edit or retire. These pin the update/delete half against the same
workspace-scoped REST paths the router exposes.
"""

from __future__ import annotations

import json

import httpx
import pytest


@pytest.mark.anyio
async def test_update_webhook_patches_workspace_scoped_path(mock_client, ctx):
    from valaris_mcp.tools.webhooks import update_webhook

    mock_client.patch.return_value = {"id": "wh-1", "url": "https://new.example/hook"}
    result = await update_webhook(
        "acme",
        "wh-1",
        url="https://new.example/hook",
        ctx=ctx,
    )

    mock_client.patch.assert_called_once_with(
        "/workspaces/acme/webhooks/wh-1",
        {"url": "https://new.example/hook"},
    )
    assert json.loads(result)["url"] == "https://new.example/hook"


@pytest.mark.anyio
async def test_update_webhook_sends_only_provided_fields(mock_client, ctx):
    """Partial-update semantics: omitted args must not blank out stored values."""
    from valaris_mcp.tools.webhooks import update_webhook

    mock_client.patch.return_value = {"id": "wh-1", "is_active": False}
    await update_webhook("acme", "wh-1", is_active=False, ctx=ctx)

    _, body = mock_client.patch.call_args[0]
    assert body == {"is_active": False}


@pytest.mark.anyio
async def test_update_webhook_can_deactivate_without_dropping_the_flag(mock_client, ctx):
    """is_active=False is a real value, not an 'unset' sentinel to be filtered out."""
    from valaris_mcp.tools.webhooks import update_webhook

    mock_client.patch.return_value = {"id": "wh-1", "is_active": False}
    await update_webhook("acme", "wh-1", events=["activity.card.moved"], is_active=False, ctx=ctx)

    _, body = mock_client.patch.call_args[0]
    assert body == {"events": ["activity.card.moved"], "is_active": False}


@pytest.mark.anyio
async def test_update_webhook_surfaces_errors_as_the_standard_mcp_shape(mock_client, ctx):
    from valaris_mcp.tools.webhooks import update_webhook

    request = httpx.Request("PATCH", "http://api/workspaces/acme/webhooks/gone")
    response = httpx.Response(404, request=request, json={"detail": "Webhook not found"})
    mock_client.patch.side_effect = httpx.HTTPStatusError(
        "not found", request=request, response=response
    )

    result = await update_webhook("acme", "gone", url="https://x.example", ctx=ctx)

    assert '"error": true' in result
    assert "404" in result


@pytest.mark.anyio
async def test_delete_webhook_issues_delete_and_confirms(mock_client, ctx):
    from valaris_mcp.tools.webhooks import delete_webhook

    mock_client.delete.return_value = None
    result = await delete_webhook("acme", "wh-1", ctx=ctx)

    mock_client.delete.assert_called_once_with("/workspaces/acme/webhooks/wh-1")
    assert "wh-1" in result
    assert "deleted" in result.lower()


@pytest.mark.anyio
async def test_delete_webhook_treats_404_as_already_deleted(mock_client, ctx):
    """A retrying agent that already succeeded must not see an error blob."""
    from valaris_mcp.tools.webhooks import delete_webhook

    request = httpx.Request("DELETE", "http://api/workspaces/acme/webhooks/gone")
    response = httpx.Response(404, request=request, json={"detail": "Webhook not found"})
    mock_client.delete.side_effect = httpx.HTTPStatusError(
        "not found", request=request, response=response
    )

    result = await delete_webhook("acme", "gone", ctx=ctx)

    assert "gone" in result
    assert '"error": true' not in result


@pytest.mark.anyio
async def test_delete_webhook_surfaces_403_as_an_error(mock_client, ctx):
    """Membership denial must stay visible, not read as a calm no-op."""
    from valaris_mcp.tools.webhooks import delete_webhook

    request = httpx.Request("DELETE", "http://api/workspaces/other/webhooks/wh-1")
    response = httpx.Response(403, request=request, json={"detail": "Not a member"})
    mock_client.delete.side_effect = httpx.HTTPStatusError(
        "forbidden", request=request, response=response
    )

    result = await delete_webhook("other", "wh-1", ctx=ctx)

    assert '"error": true' in result
    assert "403" in result


@pytest.mark.anyio
async def test_get_webhook_reads_the_workspace_scoped_path(mock_client, ctx):
    from valaris_mcp.tools.webhooks import get_webhook

    mock_client.get.return_value = {"id": "wh-1", "url": "https://example/hook"}
    result = await get_webhook("acme", "wh-1", ctx=ctx)

    mock_client.get.assert_called_once_with("/workspaces/acme/webhooks/wh-1")
    assert json.loads(result)["id"] == "wh-1"
