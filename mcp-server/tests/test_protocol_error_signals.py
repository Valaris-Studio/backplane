# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Wire-level failure signals must agree with the preserved JSON receipt."""

import json
from datetime import timedelta

import httpx
import pytest
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import CallToolResult, TextContent

from valaris_mcp import server as server_module
from valaris_mcp.tools.cards import update_card
from valaris_mcp.tools.skills import propose_skill


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def server(monkeypatch, mock_client, ctx):
    # Exercise the production lifespan/manager wrappers, not a bare FastMCP
    # instance that would miss the application's protocol boundary.
    monkeypatch.setattr(server_module, "ValarisClient", lambda: mock_client)
    monkeypatch.setattr(
        server_module,
        "ExecutionTracker",
        lambda _client: ctx.request_context.lifespan_context.tracker,
    )
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "all")
    instance = FastMCP("error-signal-test", lifespan=server_module.app_lifespan)
    instance.add_tool(propose_skill)
    instance.add_tool(update_card)

    async def receipt(payload: str) -> str:
        return payload

    instance.add_tool(receipt)

    async def native_error() -> CallToolResult:
        return CallToolResult(
            content=[TextContent(type="text", text="Permission denied")],
            structuredContent={"reason": "forbidden"},
            isError=True,
        )

    instance.add_tool(native_error)
    return instance


PROPOSAL = {
    "workspace_slug": "test",
    "slug": "test-skill",
    "files": [{"path": "SKILL.md", "content": "# Test"}],
}


async def call(server, name, arguments):
    async with create_connected_server_and_client_session(
        server, read_timeout_seconds=timedelta(seconds=5)
    ) as session:
        return await session.call_tool(name, arguments)


@pytest.mark.anyio
async def test_proposal_forbidden_sets_protocol_error_preserving_backend_receipt(
    server, mock_client
):
    response = httpx.Response(
        403,
        json={
            "detail": "Skill proposals are disabled for this board",
            "error_code": "proposals_disabled",
        },
        request=httpx.Request("POST", "http://test/workspaces/test/skills/proposals"),
    )
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=response.request, response=response
    )
    result = await call(server, "propose_skill", PROPOSAL)
    assert json.loads(result.content[0].text) == {
        "error": True,
        "status": 403,
        "message": "Skill proposals are disabled for this board",
        "error_code": "proposals_disabled",
    }
    assert result.isError is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    "failure", [httpx.ConnectError("offline"), httpx.ReadTimeout("slow"), httpx.ReadError("reset")]
)
async def test_transport_failure_sets_protocol_error_with_useful_receipt(
    server, mock_client, failure
):
    mock_client.post.side_effect = failure
    result = await call(server, "propose_skill", PROPOSAL)
    payload = json.loads(result.content[0].text)
    assert payload["error"] is True
    assert payload["message"]
    assert result.isError is True


@pytest.mark.anyio
async def test_local_validation_failure_sets_protocol_error_without_api_call(server, mock_client):
    result = await call(
        server,
        "update_card",
        {
            "workspace_slug": "test",
            "board_id": "b1",
            "card_id": "12345678-1234-1234-1234-123456789012",
            "clear_fields": ["status"],
            "status": "pending",
        },
    )
    payload = json.loads(result.content[0].text)
    assert payload["error"] is True
    assert payload["status"] == 422
    mock_client.patch.assert_not_awaited()
    assert result.isError is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    "payload",
    [
        {"id": "entity", "status": "failed"},
        {"id": "entity", "status": 403},
        {"error": "Already exists", "existing": {"id": "entity"}},
        {"error": False, "status": "pending"},
        {"error": 1, "status": "pending"},
        {"items": [{"error": True}]},
    ],
)
async def test_entity_status_and_nonboolean_error_do_not_signal_tool_failure(server, payload):
    result = await call(server, "receipt", {"payload": json.dumps(payload)})
    assert json.loads(result.content[0].text) == payload
    assert result.isError is False


@pytest.mark.anyio
async def test_proposal_success_remains_success(server, mock_client):
    mock_client.post.return_value = {
        "approval_id": "a1",
        "status": "pending",
        "skill_slug": "test-skill",
    }
    result = await call(server, "propose_skill", PROPOSAL)
    assert json.loads(result.content[0].text)["approval_id"] == "a1"
    assert result.isError is False


@pytest.mark.anyio
async def test_existing_protocol_failure_preserves_content_and_structured_content(server, ctx):
    result = await call(server, "native_error", {})
    assert result.isError is True
    assert result.content[0].text == "Permission denied"
    assert result.structuredContent == {"reason": "forbidden"}
    observed = ctx.request_context.lifespan_context.tracker.after_tool_call.call_args.args[1]
    assert observed.isError is True


@pytest.mark.anyio
async def test_converted_error_retains_structured_receipt_and_tracker_signal(server, ctx):
    payload = json.dumps({"error": True, "message": "Rejected"})
    result = await call(server, "receipt", {"payload": payload})
    assert result.content[0].text == payload
    assert result.structuredContent == {"result": payload}
    observed = ctx.request_context.lifespan_context.tracker.after_tool_call.call_args.args[1]
    assert observed.isError is True
