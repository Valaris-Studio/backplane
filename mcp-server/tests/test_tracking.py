# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for per-tool-call execution tracking.

See `valaris_mcp/tracking.py` module docstring for scoping rationale
(card d8797e78 — the old per-session model wedged the backend busy-gate).
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, ImageContent, TextContent

from valaris_mcp.tracking import ExecutionTracker

pytestmark = pytest.mark.anyio


def _make_tracker(client, api_key="vlr_test1234abcd"):
    with patch("valaris_mcp.tracking.API_KEY", api_key):
        return ExecutionTracker(client)


async def _setup(client, agent_id="agent-222", exec_id_seq=("exec-001",)):
    """Prime a tracker with agent lookup + a queued POST response."""
    client.get = AsyncMock(return_value=[
        {"id": agent_id, "api_key_prefix": "vlr_test", "is_active": True},
    ])
    exec_ids = list(exec_id_seq)

    async def _post(path, body):
        if path.endswith("/executions"):
            return {"id": exec_ids.pop(0), "agent_id": agent_id, "status": "started"}
        return {}

    client.post = AsyncMock(side_effect=_post)
    client.patch = AsyncMock(return_value={"status": "completed"})
    return _make_tracker(client)


# ---------- Identity + disable ----------


async def test_tracker_disabled_without_api_key():
    client = AsyncMock()
    tracker = _make_tracker(client, api_key="")
    assert tracker._disabled is True


async def test_tracker_enabled_with_api_key():
    client = AsyncMock()
    tracker = _make_tracker(client)
    assert tracker._disabled is False


async def test_discover_agent_id_matches_prefix():
    client = AsyncMock()
    client.get = AsyncMock(return_value=[
        {"id": "agent-111", "api_key_prefix": "vlr_aaaa"},
        {"id": "agent-222", "api_key_prefix": "vlr_test"},
    ])
    tracker = _make_tracker(client)
    await tracker._discover_agent_id()
    assert tracker._agent_id == "agent-222"


async def test_discover_agent_id_is_cached():
    client = AsyncMock()
    client.get = AsyncMock(return_value=[
        {"id": "agent-222", "api_key_prefix": "vlr_test"},
    ])
    tracker = _make_tracker(client)
    await tracker._discover_agent_id()
    await tracker._discover_agent_id()
    assert client.get.call_count == 1


async def test_discover_agent_id_no_match_disables():
    client = AsyncMock()
    client.get = AsyncMock(return_value=[
        {"id": "agent-111", "api_key_prefix": "vlr_aaaa"},
    ])
    tracker = _make_tracker(client, api_key="vlr_xxxx9999")
    await tracker._discover_agent_id()
    assert tracker._disabled is True


async def test_discover_agent_id_failure_disables():
    client = AsyncMock()
    client.get = AsyncMock(side_effect=httpx.ConnectError("connection refused"))
    tracker = _make_tracker(client)
    await tracker._discover_agent_id()
    assert tracker._disabled is True


# ---------- Per-call lifecycle ----------


async def test_before_tool_call_starts_one_execution():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default", "board_id": "b1"})

    exec_calls = [c for c in client.post.call_args_list if c.args[0].endswith("/executions")]
    assert len(exec_calls) == 1
    path, body = exec_calls[0].args
    assert path == "/agents/agent-222/executions"
    assert body["action"] == "mcp_session"
    assert body["workspace_slug"] == "default"
    assert body["board_id"] == "b1"
    assert tracker._active["execution_id"] == "exec-001"


async def test_after_tool_call_finalizes_and_clears():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", '{"name": "Board"}')

    client.patch.assert_called_once()
    patch_path, patch_body = client.patch.call_args.args
    assert patch_path == "/agents/agent-222/executions/exec-001"
    assert patch_body["status"] == "completed"
    assert patch_body["tools_used"] == ["get_board"]
    assert patch_body["tool_calls_count"] == 1
    assert "duration_seconds" in patch_body

    invocation_calls = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ]
    assert len(invocation_calls) == 1
    path, invocations = invocation_calls[0].args
    assert path == "/agents/agent-222/executions/exec-001/tool-invocations"
    assert len(invocations) == 1
    assert invocations[0]["tool_name"] == "get_board"
    assert invocations[0]["status"] == "completed"

    assert tracker._active is None


async def test_each_call_gets_its_own_execution():
    """Regression guard for card d8797e78 — no row outlives its call."""
    client = AsyncMock()
    tracker = await _setup(client, exec_id_seq=("exec-1", "exec-2"))
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", "{}")
    await tracker.before_tool_call("list_cards", {"workspace_slug": "default"})
    await tracker.after_tool_call("list_cards", "[]")

    exec_creates = [c for c in client.post.call_args_list if c.args[0].endswith("/executions")]
    assert len(exec_creates) == 2
    assert client.patch.call_count == 2
    patched_ids = {c.args[0].rsplit("/", 1)[-1] for c in client.patch.call_args_list}
    assert patched_ids == {"exec-1", "exec-2"}


async def test_skips_tracking_tools():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("log_execution_start", {"agent_id": "a1", "action": "x"})
    assert tracker._active is None
    client.post.assert_not_called()


async def test_defers_when_no_workspace_slug():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("list_workspaces", {})
    assert tracker._active is None
    client.post.assert_not_called()
    await tracker.after_tool_call("list_workspaces", "[]")
    client.patch.assert_not_called()


# ---------- Card ID extraction ----------


async def test_captures_card_id_on_create():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("create_card", {"workspace_slug": "default"})
    await tracker.after_tool_call("create_card", json.dumps({"id": "card-123"}))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["cards_affected"] == ["card-123"]


async def test_captures_card_ids_from_bulk():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("bulk_create_cards", {"workspace_slug": "default"})
    await tracker.after_tool_call(
        "bulk_create_cards",
        json.dumps({"cards": [{"id": "c1"}, {"id": "c2"}]}),
    )
    patch_body = client.patch.call_args.args[1]
    assert set(patch_body["cards_affected"]) == {"c1", "c2"}


async def test_ignores_non_card_tools_for_extraction():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("list_boards", {"workspace_slug": "default"})
    await tracker.after_tool_call("list_boards", json.dumps({"id": "board-1"}))
    patch_body = client.patch.call_args.args[1]
    assert patch_body["cards_affected"] == []


# ---------- Truncation ----------


async def test_arguments_summary_truncated():
    client = AsyncMock()
    tracker = await _setup(client)
    long_args = {"workspace_slug": "default", "data": "x" * 500}
    await tracker.before_tool_call("create_card", long_args)
    await tracker.after_tool_call("create_card", "{}")

    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    invocations = invocation_post.args[1]
    assert len(invocations[0]["arguments_summary"]) <= 200


async def test_result_summary_truncated():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("list_cards", {"workspace_slug": "default"})
    await tracker.after_tool_call("list_cards", "y" * 1000)

    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    invocations = invocation_post.args[1]
    assert len(invocations[0]["result_summary"]) <= 500


# ---------- Error isolation ----------


async def test_before_swallows_post_failure():
    client = AsyncMock()
    client.get = AsyncMock(return_value=[
        {"id": "agent-222", "api_key_prefix": "vlr_test"},
    ])
    client.post = AsyncMock(side_effect=httpx.ConnectError("down"))
    tracker = _make_tracker(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    assert tracker._active is None


async def test_after_swallows_parse_errors():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("create_card", {"workspace_slug": "default"})
    await tracker.after_tool_call("create_card", "not json {{{")
    client.patch.assert_called_once()


async def test_after_swallows_patch_failure():
    client = AsyncMock()
    tracker = await _setup(client)
    client.patch = AsyncMock(side_effect=RuntimeError("500"))
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", "{}")
    assert tracker._active is None


async def test_after_without_matching_before_is_noop():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.after_tool_call("get_board", "{}")
    client.patch.assert_not_called()


# ---------- Error-result detection (card b59bd8b2) ----------
#
# handle_api_errors (errors.py) never raises on an httpx error — it returns a
# JSON string like {"error": true, "status": 422, "message": "...",
# "error_code": "pr_url_missing"}. after_tool_call must inspect that payload
# and record "failed", not "completed", on both the execution PATCH and the
# tool-invocation POST. Idempotent-create success payloads (no "error" key)
# must keep recording "completed".


async def test_after_tool_call_records_failed_on_error_result():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("update_card", {"workspace_slug": "default"})
    error_result = json.dumps({
        "error": True,
        "status": 422,
        "message": "pr_url is required to move to this column",
        "error_code": "pr_url_missing",
    })
    await tracker.after_tool_call("update_card", error_result)

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"

    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    invocations = invocation_post.args[1]
    assert invocations[0]["status"] == "failed"


async def test_after_tool_call_error_message_includes_status_and_error_code():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("update_card", {"workspace_slug": "default"})
    error_result = json.dumps({
        "error": True,
        "status": 422,
        "message": "pr_url is required to move to this column",
        "error_code": "pr_url_missing",
    })
    await tracker.after_tool_call("update_card", error_result)

    patch_body = client.patch.call_args.args[1]
    assert "422" in patch_body["error_message"]
    assert "pr_url_missing" in patch_body["error_message"]

    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    invocations = invocation_post.args[1]
    assert "422" in invocations[0]["error_message"]
    assert "pr_url_missing" in invocations[0]["error_message"]


async def test_after_tool_call_error_message_omits_error_code_when_absent():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    error_result = json.dumps({
        "error": True,
        "message": "Cannot reach the Valaris API. Is the server running?",
    })
    await tracker.after_tool_call("get_board", error_result)

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert "Cannot reach the Valaris API" in patch_body["error_message"]


async def test_idempotent_create_returning_existing_entity_stays_completed():
    """Idempotency invariant (card d... idempotent mutations): a retried
    add_card_participant that returns the pre-existing participant is a
    normal success payload with no "error" key, so it must record as
    "completed", not "failed".
    """
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("add_card_participant", {"workspace_slug": "default"})
    existing_participant_result = json.dumps({
        "id": "participant-1",
        "card_id": "card-123",
        "user_id": "user-456",
        "role": "assignee",
    })
    await tracker.after_tool_call("add_card_participant", existing_participant_result)

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"

    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    invocations = invocation_post.args[1]
    assert invocations[0]["status"] == "completed"


async def test_create_workspace_duplicate_slug_stays_completed():
    """The idempotency invariant's real at-risk shape: create_workspace
    (tools/workspaces.py) reports an existing slug as a *string*-valued
    "error" alongside the entity it found — nothing failed, nothing raised,
    and the caller got the workspace it asked for. Only handle_api_errors'
    boolean `"error": true` means failure.

    Classification is asserted directly: create_workspace takes no
    workspace_slug, so before_tool_call defers and never opens an execution
    row to inspect.
    """
    duplicate_result = json.dumps({
        "error": "Workspace with slug 'existing' already exists",
        "existing": {"id": "ws-1", "slug": "existing", "name": "Existing"},
    })
    assert ExecutionTracker._classify_result(duplicate_result) == ("completed", None)


async def test_string_valued_error_key_stays_completed():
    """Guards the boundary from the other side: only the boolean means
    failure, so a tool that happens to carry a descriptive "error" string
    is never recorded as a failed execution.
    """
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call(
        "get_board", json.dumps({"error": "some descriptive text", "id": "board-1"})
    )

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    assert "error_message" not in patch_body


async def test_after_tool_call_non_json_string_result_stays_completed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", "not json {{{")

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"


async def test_after_tool_call_unrecognised_non_str_result_stays_completed():
    """A value that is neither text nor MCP content (an int here) carries no
    error payload to inspect, so it records as a plain success. Content lists
    are NOT in this bucket — see the converted-results section below.
    """
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("list_cards", {"workspace_slug": "default"})
    await tracker.after_tool_call("list_cards", 42)

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    assert "error_message" not in patch_body


async def test_after_tool_call_json_list_result_stays_completed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("list_cards", {"workspace_slug": "default"})
    await tracker.after_tool_call("list_cards", json.dumps([{"id": "card-1"}]))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"


async def test_after_tool_call_dict_without_error_key_stays_completed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", json.dumps({"name": "Board", "id": "b1"}))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"


async def test_after_tool_call_falsy_error_key_stays_completed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", json.dumps({"error": False, "id": "b1"}))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"


async def test_patch_and_invocation_status_agree_on_error():
    """Both status sites must agree — no split-brain between the execution
    row and its tool-invocation row.
    """
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("update_card", {"workspace_slug": "default"})
    error_result = json.dumps({"error": True, "status": 500, "message": "boom"})
    await tracker.after_tool_call("update_card", error_result)

    patch_body = client.patch.call_args.args[1]
    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    invocation_status = invocation_post.args[1][0]["status"]
    assert patch_body["status"] == invocation_status == "failed"


# ---------- finalize (shutdown) ----------


async def test_finalize_is_noop_when_no_active_call():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.finalize()
    client.patch.assert_not_called()


async def test_finalize_aborts_inflight_call():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    # Process is shutting down before after_tool_call fires
    await tracker.finalize()
    client.patch.assert_called_once()
    body = client.patch.call_args.args[1]
    assert body["status"] == "aborted"


async def test_finalize_noop_when_disabled():
    client = AsyncMock()
    tracker = _make_tracker(client, api_key="")
    await tracker.finalize()


# ---------- Server wiring ----------


async def test_install_tracking_wraps_call_tool():
    from valaris_mcp.server import install_tracking
    tracker = AsyncMock()
    original_call_tool = AsyncMock(return_value="result")

    class FakeToolManager:
        call_tool = original_call_tool

    class FakeServer:
        _tool_manager = FakeToolManager()

    install_tracking(FakeServer(), tracker)

    result = await FakeServer._tool_manager.call_tool("get_board", {"workspace_slug": "x"})
    tracker.before_tool_call.assert_called_once_with("get_board", {"workspace_slug": "x"})
    tracker.after_tool_call.assert_called_once_with("get_board", "result")
    assert result == "result"


def test_app_context_has_tracker():
    from valaris_mcp.server import AppContext
    client = AsyncMock()
    tracker = AsyncMock(spec=ExecutionTracker)
    ctx = AppContext(client=client, tracker=tracker)
    assert ctx.tracker is tracker


# ---------- Converted results (cards 6a25bc2f / 8ddbedac) ----------
#
# `install_tracking` wraps `_tool_manager.call_tool`, but `FastMCP.call_tool`
# invokes the manager with `convert_result=True`, so the value reaching
# `after_tool_call` is what `FuncMetadata.convert_result` produced — never the
# tool's raw JSON string:
#   - `list[TextContent]`                 tool without an output schema (every
#                                         tool in this server)
#   - `(list[TextContent], dict)`         tool with an output schema
#   - `CallToolResult`                    passthrough
# The tracker must unwrap the TextContent text before classifying, extracting
# card ids and summarising — otherwise every row is "completed", no card is
# ever attributed and result_summary is a `[TextContent(...)]` repr.

ERROR_PAYLOAD = {
    "error": True,
    "status": 422,
    "message": "pr_url is required to move to this column",
    "error_code": "pr_url_missing",
}
ERROR_MESSAGE = "422 pr_url is required to move to this column pr_url_missing"


def _text(payload) -> TextContent:
    return TextContent(type="text", text=json.dumps(payload))


def _invocation(client) -> dict:
    invocation_post = [
        c for c in client.post.call_args_list
        if c.args[0].endswith("/tool-invocations")
    ][0]
    return invocation_post.args[1][0]


async def test_after_tool_call_content_list_error_records_failed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("update_card", {"workspace_slug": "default"})
    await tracker.after_tool_call("update_card", [_text(ERROR_PAYLOAD)])

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == ERROR_MESSAGE
    invocation = _invocation(client)
    assert invocation["status"] == "failed"
    assert invocation["error_message"] == ERROR_MESSAGE


async def test_after_tool_call_content_list_captures_card_id():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("create_card", {"workspace_slug": "default"})
    await tracker.after_tool_call("create_card", [_text({"id": "card-123"})])

    patch_body = client.patch.call_args.args[1]
    assert patch_body["cards_affected"] == ["card-123"]


async def test_after_tool_call_content_list_captures_bulk_card_ids():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("bulk_create_cards", {"workspace_slug": "default"})
    await tracker.after_tool_call(
        "bulk_create_cards", [_text({"cards": [{"id": "c1"}, {"id": "c2"}]})]
    )

    patch_body = client.patch.call_args.args[1]
    assert set(patch_body["cards_affected"]) == {"c1", "c2"}


async def test_after_tool_call_content_list_summary_is_the_text_not_the_repr():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    board_json = json.dumps({"id": "b1", "name": "Board"})
    await tracker.after_tool_call("get_board", [TextContent(type="text", text=board_json)])

    assert _invocation(client)["result_summary"] == board_json


async def test_after_tool_call_content_list_summary_truncates_the_text_at_500():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("list_cards", {"workspace_slug": "default"})
    long_text = "y" * 1000
    await tracker.after_tool_call("list_cards", [TextContent(type="text", text=long_text)])

    assert _invocation(client)["result_summary"] == long_text[:500]


async def test_after_tool_call_structured_tuple_error_records_failed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("update_card", {"workspace_slug": "default"})
    await tracker.after_tool_call(
        "update_card", ([_text(ERROR_PAYLOAD)], {"result": json.dumps(ERROR_PAYLOAD)})
    )

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == ERROR_MESSAGE
    assert _invocation(client)["status"] == "failed"


async def test_after_tool_call_structured_tuple_captures_card_id():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("create_card", {"workspace_slug": "default"})
    await tracker.after_tool_call(
        "create_card", ([_text({"id": "card-123"})], {"result": '{"id": "card-123"}'})
    )

    patch_body = client.patch.call_args.args[1]
    assert patch_body["cards_affected"] == ["card-123"]


async def test_after_tool_call_structured_tuple_summary_is_the_unstructured_text():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    board_json = json.dumps({"id": "b1"})
    await tracker.after_tool_call(
        "get_board", ([TextContent(type="text", text=board_json)], {"result": board_json})
    )

    assert _invocation(client)["result_summary"] == board_json


async def test_after_tool_call_call_tool_result_error_records_failed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("update_card", {"workspace_slug": "default"})
    await tracker.after_tool_call("update_card", CallToolResult(content=[_text(ERROR_PAYLOAD)]))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == ERROR_MESSAGE
    assert _invocation(client)["status"] == "failed"


async def test_after_tool_call_call_tool_result_captures_card_id():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("create_card", {"workspace_slug": "default"})
    await tracker.after_tool_call("create_card", CallToolResult(content=[_text({"id": "card-123"})]))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["cards_affected"] == ["card-123"]


async def test_after_tool_call_call_tool_result_summary_is_the_text():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    board_json = json.dumps({"id": "b1"})
    await tracker.after_tool_call(
        "get_board", CallToolResult(content=[TextContent(type="text", text=board_json)])
    )

    assert _invocation(client)["result_summary"] == board_json


async def test_after_tool_call_multi_text_content_joins_texts_with_newlines():
    """Pinned choice: every TextContent text, in order, newline-joined."""
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call(
        "get_board",
        [TextContent(type="text", text="first"), TextContent(type="text", text="second")],
    )

    assert _invocation(client)["result_summary"] == "first\nsecond"


async def test_after_tool_call_multi_text_content_skips_non_text_blocks():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    image = ImageContent(type="image", data="aGk=", mimeType="image/png")
    await tracker.after_tool_call(
        "get_board",
        [TextContent(type="text", text="first"), image, TextContent(type="text", text="second")],
    )

    assert _invocation(client)["result_summary"] == "first\nsecond"


async def test_after_tool_call_image_only_content_stays_completed_with_no_summary():
    """Pinned choice: no textual payload → result_summary is None."""
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    image = ImageContent(type="image", data="aGk=", mimeType="image/png")
    await tracker.after_tool_call("get_board", [image])

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    assert "error_message" not in patch_body
    invocation = _invocation(client)
    assert invocation["status"] == "completed"
    assert invocation["result_summary"] is None


async def test_after_tool_call_empty_content_list_stays_completed_with_no_summary():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", [])

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    invocation = _invocation(client)
    assert invocation["status"] == "completed"
    assert invocation["result_summary"] is None


async def test_after_tool_call_empty_tuple_result_still_finalizes_the_row():
    """An empty structured result has no unstructured half to read; the row
    must still close rather than the unwrap blowing up inside the swallowed
    try and leaving the execution open forever."""
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", ())

    client.patch.assert_called_once()
    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    assert _invocation(client)["result_summary"] is None


async def test_after_tool_call_content_list_success_payload_stays_completed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", [_text({"id": "b1", "name": "Board"})])

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    assert "error_message" not in patch_body


# ---------- Exception path (card 8ddbedac) ----------
#
# The tracked wrapper forwards a raised exception as `error=` alongside its
# text. A denial JSON is `{"error": "tool_not_allowed", ...}` (a string, not
# the boolean True), so payload inspection alone would classify it as a
# success; an `error` always classifies the row "failed".


async def test_after_tool_call_with_error_records_failed_with_the_exception_message():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", "boom", error=RuntimeError("boom"))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == "boom"
    invocation = _invocation(client)
    assert invocation["status"] == "failed"
    assert invocation["error_message"] == "boom"


async def test_after_tool_call_with_denial_error_records_failed_and_keeps_the_denial_json():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_card", {"workspace_slug": "default"})
    denial_json = json.dumps({
        "error": "tool_not_allowed",
        "tool": "get_card",
        "allowlist": [],
        "toolsets": ["cards"],
    })
    await tracker.after_tool_call("get_card", denial_json, error=PermissionError(denial_json))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert "tool_not_allowed" in patch_body["error_message"]
    invocation = _invocation(client)
    assert invocation["status"] == "failed"
    assert "tool_not_allowed" in invocation["error_message"]
    assert invocation["result_summary"] == denial_json


async def test_after_tool_call_error_message_from_exception_is_truncated_at_500():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    long_text = "e" * 1000
    await tracker.after_tool_call("get_board", long_text, error=RuntimeError(long_text))

    patch_body = client.patch.call_args.args[1]
    assert patch_body["error_message"] == long_text[:500]


async def test_after_tool_call_with_blank_exception_records_the_exception_type():
    """`str(RuntimeError())` is empty; an empty error_message would drop the
    key and leave a failed row with no reason, so the type name stands in."""
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("get_board", {"workspace_slug": "default"})
    await tracker.after_tool_call("get_board", "", error=RuntimeError())

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == "RuntimeError"
    invocation = _invocation(client)
    assert invocation["status"] == "failed"
    assert invocation["error_message"] == "RuntimeError"


# ---------- End to end through the real FastMCP (card 6a25bc2f) ----------
#
# `FastMCP.call_tool` is the path the lowlevel server drives; it converts the
# tool's return value before the tracked wrapper ever sees it. A throwaway
# server (never the valaris singleton) proves the wiring, not a hand-built
# shape.


def _probe_server() -> FastMCP:
    server = FastMCP("probe")

    # structured_output=False mirrors this server's tools: no output schema,
    # so the manager hands back a bare `list[TextContent]`.
    @server.tool(name="create_card", structured_output=False)
    async def create_card(workspace_slug: str, title: str) -> str:
        return json.dumps({"id": "card-e2e", "title": title})

    @server.tool(name="update_card", structured_output=False)
    async def update_card(workspace_slug: str, card_id: str) -> str:
        return json.dumps(ERROR_PAYLOAD)

    # Default structured output: a `-> str` tool gets a wrapped
    # `{"result": ...}` schema, so the manager hands back the tuple shape.
    @server.tool(name="move_card")
    async def move_card(workspace_slug: str, card_id: str) -> str:
        return json.dumps({"id": "card-moved"})

    @server.tool(name="raise_probe", structured_output=False)
    async def raise_probe(workspace_slug: str) -> str:
        raise ValueError("kaboom")

    return server


async def test_fastmcp_call_tool_success_is_attributed_to_the_created_card():
    from valaris_mcp.server import install_tracking

    client = AsyncMock()
    tracker = await _setup(client)
    server = _probe_server()
    install_tracking(server, tracker)

    await server.call_tool("create_card", {"workspace_slug": "default", "title": "Probe"})

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "completed"
    assert patch_body["cards_affected"] == ["card-e2e"]
    invocation = _invocation(client)
    assert invocation["status"] == "completed"
    assert invocation["result_summary"] == json.dumps({"id": "card-e2e", "title": "Probe"})


async def test_fastmcp_call_tool_error_payload_is_recorded_as_failed():
    from valaris_mcp.server import install_tracking

    client = AsyncMock()
    tracker = await _setup(client)
    server = _probe_server()
    install_tracking(server, tracker)

    await server.call_tool("update_card", {"workspace_slug": "default", "card_id": "c1"})

    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == ERROR_MESSAGE
    invocation = _invocation(client)
    assert invocation["status"] == "failed"
    assert invocation["result_summary"] == json.dumps(ERROR_PAYLOAD)


async def test_fastmcp_call_tool_structured_output_is_attributed_to_the_card():
    from valaris_mcp.server import install_tracking

    client = AsyncMock()
    tracker = await _setup(client)
    server = _probe_server()
    install_tracking(server, tracker)

    await server.call_tool("move_card", {"workspace_slug": "default", "card_id": "c1"})

    patch_body = client.patch.call_args.args[1]
    assert patch_body["cards_affected"] == ["card-moved"]
    assert _invocation(client)["result_summary"] == json.dumps({"id": "card-moved"})


async def test_fastmcp_call_tool_raising_tool_body_is_recorded_as_failed():
    """Tool.run wraps a raising body in ToolError("Error executing tool
    <name>: <cause>") before the tracked wrapper sees it; that text is the
    row's reason and the error propagates to the caller unchanged."""
    from mcp.server.fastmcp.exceptions import ToolError

    from valaris_mcp.server import install_tracking

    client = AsyncMock()
    tracker = await _setup(client)
    server = _probe_server()
    install_tracking(server, tracker)

    with pytest.raises(ToolError) as excinfo:
        await server.call_tool("raise_probe", {"workspace_slug": "default"})

    tool_error_text = str(excinfo.value)
    assert tool_error_text == "Error executing tool raise_probe: kaboom"
    client.patch.assert_called_once()
    patch_body = client.patch.call_args.args[1]
    assert patch_body["status"] == "failed"
    assert patch_body["error_message"] == tool_error_text
    invocation = _invocation(client)
    assert invocation["status"] == "failed"
    assert invocation["error_message"] == tool_error_text
    assert invocation["result_summary"] == tool_error_text


async def test_explicit_protocol_error_without_json_records_failed():
    client = AsyncMock()
    tracker = await _setup(client)
    await tracker.before_tool_call("probe", {"workspace_slug": "default"})
    await tracker.after_tool_call("probe", CallToolResult(
        content=[TextContent(type="text", text="Permission denied")], isError=True,
    ))
    assert client.patch.call_args.args[1]["status"] == "failed"
    assert _invocation(client)["error_message"] == "Permission denied"
