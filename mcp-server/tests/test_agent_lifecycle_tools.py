# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest


def _forbidden_error() -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://api/agents/a1/pause")
    response = httpx.Response(
        403,
        json={"detail": "Agent-linked API keys cannot manage agents"},
        request=request,
    )
    return httpx.HTTPStatusError("forbidden", request=request, response=response)


@pytest.mark.anyio
async def test_list_agents_defaults_to_active_only(mock_client, ctx):
    from valaris_mcp.tools.agents import list_agents

    mock_client.get.return_value = [
        {"id": "a1", "name": "intern", "is_active": True, "is_paused": False}
    ]

    result = json.loads(await list_agents(ctx=ctx))

    mock_client.get.assert_called_once_with("/agents", include_inactive=False)
    assert result["agents"][0]["name"] == "intern"


@pytest.mark.anyio
async def test_list_agents_can_include_inactive(mock_client, ctx):
    from valaris_mcp.tools.agents import list_agents

    mock_client.get.return_value = []

    await list_agents(include_inactive=True, ctx=ctx)

    mock_client.get.assert_called_once_with("/agents", include_inactive=True)


@pytest.mark.anyio
async def test_pause_agent_posts_to_pause_route(mock_client, ctx):
    from valaris_mcp.tools.agents import pause_agent

    mock_client.post.return_value = {"id": "a1", "is_paused": True}

    result = json.loads(await pause_agent("a1", ctx=ctx))

    mock_client.post.assert_called_once_with("/agents/a1/pause")
    assert result["is_paused"] is True


@pytest.mark.anyio
async def test_pause_agent_surfaces_agent_caller_rejection(mock_client, ctx):
    from valaris_mcp.tools.agents import pause_agent

    mock_client.post.side_effect = _forbidden_error()

    result = json.loads(await pause_agent("a1", ctx=ctx))

    assert result["error"] is True
    assert result["status"] == 403
    assert "Agent-linked API keys cannot manage agents" in result["message"]


@pytest.mark.anyio
async def test_resume_agent_posts_to_resume_route(mock_client, ctx):
    from valaris_mcp.tools.agents import resume_agent

    mock_client.post.return_value = {"id": "a1", "is_paused": False}

    result = json.loads(await resume_agent("a1", ctx=ctx))

    mock_client.post.assert_called_once_with("/agents/a1/resume")
    assert result["is_paused"] is False


@pytest.mark.anyio
async def test_get_agent_budget_status_reads_per_agent_route(mock_client, ctx):
    from valaris_mcp.tools.agents import get_agent_budget_status

    mock_client.get.return_value = {"budget_usd": 50.0, "spent_usd": 12.5, "exceeded": False}

    result = json.loads(await get_agent_budget_status("a1", ctx=ctx))

    mock_client.get.assert_called_once_with("/agents/a1/budget-status")
    assert result["spent_usd"] == 12.5


@pytest.mark.anyio
async def test_rotate_agent_key_returns_the_new_key_once(mock_client, ctx):
    from valaris_mcp.tools.agents import rotate_agent_key

    mock_client.post.return_value = {
        "id": "a1",
        "api_key_prefix": "vk_new",
        "raw_api_key": "vk_new_secret_value",
    }

    raw = await rotate_agent_key("a1", ctx=ctx)
    result = json.loads(raw)

    mock_client.post.assert_called_once_with("/agents/a1/rotate-key")
    assert result["raw_api_key"] == "vk_new_secret_value"
    assert raw.count("vk_new_secret_value") == 1


@pytest.mark.anyio
async def test_rotate_agent_key_result_never_reaches_execution_tracking(mock_client):
    """The raw key must not land in a persisted result_summary.

    Tracking opens an execution row only for tools carrying a workspace_slug;
    rotate_agent_key is workspace-less, so after_tool_call has no active row
    and never posts the result anywhere.
    """
    from valaris_mcp.tracking import ExecutionTracker

    tracker = ExecutionTracker(mock_client)

    await tracker.before_tool_call("rotate_agent_key", {"agent_id": "a1"})
    await tracker.after_tool_call("rotate_agent_key", '{"raw_api_key": "vk_new_secret_value"}')

    posted = [str(call) for call in mock_client.post.call_args_list]
    assert not any("vk_new_secret_value" in call for call in posted)


@pytest.mark.anyio
async def test_rotate_agent_key_surfaces_agent_caller_rejection(mock_client, ctx):
    from valaris_mcp.tools.agents import rotate_agent_key

    mock_client.post.side_effect = _forbidden_error()

    result = json.loads(await rotate_agent_key("a1", ctx=ctx))

    assert result["error"] is True
    assert result["status"] == 403


@pytest.mark.anyio
async def test_restart_agent_posts_to_restart_route(mock_client, ctx):
    from valaris_mcp.tools.agents import restart_agent

    mock_client.post.return_value = {"status": "restart_requested", "agent_id": "a1"}

    result = json.loads(await restart_agent("a1", ctx=ctx))

    mock_client.post.assert_called_once_with("/agents/a1/restart")
    assert result["status"] == "restart_requested"
    assert "_hint" in result


@pytest.mark.anyio
async def test_restart_agent_surfaces_offline_runner(mock_client, ctx):
    """503 means nothing was listening — the caller must not read that as success."""
    from valaris_mcp.tools.agents import restart_agent

    request = httpx.Request("POST", "http://api/agents/a1/restart")
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "unavailable",
        request=request,
        response=httpx.Response(503, json={"detail": "agent offline"}, request=request),
    )

    result = json.loads(await restart_agent("a1", ctx=ctx))

    assert "error" in result


@pytest.mark.anyio
async def test_hard_delete_agent_calls_hard_route(mock_client, ctx):
    from valaris_mcp.tools.agents import hard_delete_agent

    mock_client.delete.return_value = None

    result = json.loads(await hard_delete_agent("a1", confirm=True, ctx=ctx))

    mock_client.delete.assert_called_once_with("/agents/a1/hard")
    assert result["deleted"] is True


@pytest.mark.anyio
async def test_hard_delete_agent_requires_confirm(mock_client, ctx):
    """Unrecoverable and one call away from an LLM's retry loop — refuse by default."""
    from valaris_mcp.tools.agents import hard_delete_agent

    result = json.loads(await hard_delete_agent("a1", ctx=ctx))

    mock_client.delete.assert_not_called()
    assert result["deleted"] is False


@pytest.mark.anyio
async def test_hard_delete_agent_surfaces_in_flight_refusal(mock_client, ctx):
    from valaris_mcp.tools.agents import hard_delete_agent

    request = httpx.Request("DELETE", "http://api/agents/a1/hard")
    mock_client.delete.side_effect = httpx.HTTPStatusError(
        "conflict",
        request=request,
        response=httpx.Response(409, json={"detail": "card in flight"}, request=request),
    )

    result = json.loads(await hard_delete_agent("a1", confirm=True, ctx=ctx))

    assert "error" in result
