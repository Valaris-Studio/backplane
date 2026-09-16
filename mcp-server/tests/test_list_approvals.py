# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest


@pytest.mark.anyio
async def test_list_approvals_success(mock_client, ctx):
    from valaris_mcp.tools.approvals import list_approvals

    mock_client.get.return_value = [
        {"id": "ap-1", "status": "pending", "category": "deletion"},
        {"id": "ap-2", "status": "approved", "category": "deployment"},
    ]
    result = json.loads(await list_approvals(workspace_slug="test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/approvals")
    assert result["count"] == 2
    assert len(result["approvals"]) == 2
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_approvals_status_filter_passthrough(mock_client, ctx):
    from valaris_mcp.tools.approvals import list_approvals

    mock_client.get.return_value = [{"id": "ap-1", "status": "pending"}]
    result = json.loads(await list_approvals(workspace_slug="test", status="pending", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/approvals", status="pending")
    assert result["count"] == 1


@pytest.mark.anyio
async def test_list_approvals_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.approvals import list_approvals

    mock_client.get.return_value = []
    result = json.loads(await list_approvals(workspace_slug="test", status="pending", ctx=ctx))
    assert result["count"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_approvals_api_error_surfaced_as_json(mock_client, ctx):
    from valaris_mcp.tools.approvals import list_approvals

    resp = httpx.Response(
        404,
        json={"detail": "Workspace not found"},
        request=httpx.Request("GET", "http://test"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    result = json.loads(await list_approvals(workspace_slug="missing", ctx=ctx))
    assert result["error"] is True
    assert result["status"] == 404
    assert result["message"] == "Workspace not found"
