# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for the delete_workspace MCP tool (card 21c0c943)."""

from __future__ import annotations

import httpx
import pytest


@pytest.mark.anyio
async def test_delete_workspace_issues_delete_and_confirms(mock_client, ctx):
    from valaris_mcp.tools.workspaces import delete_workspace

    mock_client.delete.return_value = None
    result = await delete_workspace("doomed-ws", ctx=ctx)

    mock_client.delete.assert_called_once_with("/workspaces/doomed-ws")
    assert isinstance(result, str)
    assert "doomed-ws" in result
    assert "deleted" in result.lower()


@pytest.mark.anyio
async def test_delete_workspace_treats_404_as_already_deleted(mock_client, ctx):
    """A retrying agent that already succeeded must not see an error blob."""
    from valaris_mcp.tools.workspaces import delete_workspace

    request = httpx.Request("DELETE", "http://api/workspaces/gone-ws")
    response = httpx.Response(404, request=request, json={"detail": "Workspace not found"})
    mock_client.delete.side_effect = httpx.HTTPStatusError(
        "not found", request=request, response=response
    )

    result = await delete_workspace("gone-ws", ctx=ctx)

    assert isinstance(result, str)
    assert "gone-ws" in result
    assert "not found" in result.lower()
    assert '"error": true' not in result


@pytest.mark.anyio
async def test_delete_workspace_surfaces_non_404_errors(mock_client, ctx):
    """403 from the admin gate must stay a visible error, not a calm no-op."""
    from valaris_mcp.tools.workspaces import delete_workspace

    request = httpx.Request("DELETE", "http://api/workspaces/locked-ws")
    response = httpx.Response(403, request=request, json={"detail": "Admin required"})
    mock_client.delete.side_effect = httpx.HTTPStatusError(
        "forbidden", request=request, response=response
    )

    result = await delete_workspace("locked-ws", ctx=ctx)

    assert '"error": true' in result
    assert "403" in result
