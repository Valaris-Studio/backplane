# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest


@pytest.mark.anyio
async def test_list_executions_workspace_default(mock_client, ctx):
    from valaris_mcp.tools.agents import list_executions

    mock_client.get.return_value = [
        {"id": "exec-1", "agent_id": "a1", "action": "implement", "status": "completed"},
        {"id": "exec-2", "agent_id": "a1", "action": "review", "status": "running"},
    ]
    result = json.loads(await list_executions("test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/executions", limit=20)
    assert len(result) == 2
    assert result[0]["id"] == "exec-1"


@pytest.mark.anyio
async def test_list_executions_agent_scope(mock_client, ctx):
    from valaris_mcp.tools.agents import list_executions

    mock_client.get.return_value = [
        {"id": "exec-9", "agent_id": "a1", "action": "implement", "status": "failed"},
    ]
    result = json.loads(await list_executions("test", agent_id="a1", ctx=ctx))
    mock_client.get.assert_called_once_with(
        "/workspaces/test/executions", limit=20, agent_id="a1"
    )
    assert result[0]["agent_id"] == "a1"


@pytest.mark.anyio
async def test_list_executions_filter_passthrough(mock_client, ctx):
    from valaris_mcp.tools.agents import list_executions

    mock_client.get.return_value = []
    await list_executions(
        "test",
        agent_id="a1",
        status="inflight",
        role="implementer",
        card_id="c1",
        limit=100,
        ctx=ctx,
    )
    mock_client.get.assert_called_once_with(
        "/workspaces/test/executions",
        limit=100,
        agent_id="a1",
        status="inflight",
        role="implementer",
        card_id="c1",
    )


@pytest.mark.anyio
async def test_list_executions_limit_clamped_to_200(mock_client, ctx):
    from valaris_mcp.tools.agents import list_executions

    mock_client.get.return_value = []
    await list_executions("test", limit=500, ctx=ctx)
    # Backend declares Query(le=200) which 422-rejects, not caps — the tool
    # clamps client-side so the docstring's "caps at 200" is literally true.
    mock_client.get.assert_called_once_with("/workspaces/test/executions", limit=200)


@pytest.mark.anyio
async def test_list_executions_backend_error(mock_client, ctx):
    from valaris_mcp.tools.agents import list_executions

    resp = httpx.Response(
        404,
        json={"detail": "Workspace not found"},
        request=httpx.Request("GET", "http://test/api/workspaces/nope/executions"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    result = json.loads(await list_executions("nope", ctx=ctx))
    assert result["error"] is True
    assert result["status"] == 404
    assert result["message"] == "Workspace not found"
