# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Automatic execution tracking for MCP tool sessions.

Scoping model: one `mcp_session` execution PER tool call, not per client
lifetime. The previous design opened a single row on the first tool call
and only closed it on MCP server shutdown — a long-running Claude Code
session meant an indefinitely-`started` row, which was enough to wedge
the backend `/next-assignment` busy-gate (see card d8797e78). Per-call
scoping gives every row a bounded lifetime and matches the semantics the
admin view already expects: one execution = one unit of work.

Tracking tools (`log_execution_start`, `log_execution_update`, `get_agent_config`)
are skipped because the runner manages those rows explicitly.

The wrapper in `server.py` sits on `_tool_manager.call_tool`, which
`FastMCP.call_tool` drives with `convert_result=True` — so `after_tool_call`
receives the SDK-converted shape (content blocks), not the tool's raw JSON
string. `_result_text` unwraps it before anything is classified or summarised.
"""
from __future__ import annotations

import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from mcp.types import CallToolResult, TextContent

from valaris_mcp.config import API_KEY

logger = logging.getLogger(__name__)

TRACKING_TOOLS = {"log_execution_start", "log_execution_update", "get_agent_config"}
CARD_MUTATING_TOOLS = {"create_card", "update_card", "delete_card", "move_card", "bulk_create_cards"}

MAX_ARGS_SUMMARY = 200
MAX_RESULT_SUMMARY = 500


class ExecutionTracker:
    """Per-tool-call execution tracking.

    Each intercepted tool call opens its own `mcp_session` execution row,
    posts the invocation, and finalizes the row — so no state outlives
    the call that created it. Failures silently disable tracking rather
    than propagating to the tool caller.
    """

    def __init__(self, client: Any) -> None:
        self._client = client
        self._key_prefix: str = API_KEY[:8] if API_KEY else ""
        self._agent_id: str | None = None
        self._disabled: bool = not bool(API_KEY)
        self._active: dict[str, Any] | None = None

    async def _discover_agent_id(self) -> None:
        """Match our API key prefix against registered runners. Cached."""
        if self._disabled or self._agent_id is not None:
            return
        try:
            agents = await self._client.get("/agents")
            for agent in agents:
                if agent.get("api_key_prefix") == self._key_prefix:
                    self._agent_id = agent["id"]
                    return
            self._disabled = True
        except Exception:
            self._disabled = True

    async def before_tool_call(self, name: str, arguments: dict) -> None:
        if self._disabled or name in TRACKING_TOOLS:
            return
        try:
            workspace_slug = arguments.get("workspace_slug")
            if not workspace_slug:
                # No workspace context = no execution can be created. Still
                # track the invocation locally so a later finalize() flushes
                # it if the caller later associates with a workspace.
                return

            await self._discover_agent_id()
            if self._disabled or not self._agent_id:
                return

            body: dict = {
                "workspace_slug": workspace_slug,
                "action": "mcp_session",
                "input_summary": f"MCP tool call '{name}' in workspace '{workspace_slug}'",
            }
            if board_id := arguments.get("board_id"):
                body["board_id"] = board_id

            try:
                result = await self._client.post(
                    f"/agents/{self._agent_id}/executions", body
                )
            except Exception:
                return

            execution_id = result.get("id")
            if not execution_id:
                return

            args_json = json.dumps(arguments, default=str)
            self._active = {
                "execution_id": execution_id,
                "tool_name": name,
                "arguments_summary": args_json[:MAX_ARGS_SUMMARY],
                "started_at": datetime.now(timezone.utc).isoformat(),
                "start_mono": time.monotonic(),
                "cards_affected": set(),
            }
        except Exception:
            pass

    async def after_tool_call(
        self, name: str, result: Any, *, error: BaseException | None = None
    ) -> None:
        """Finalize the call's row. `error` is the exception the call raised
        (the wrapper re-raises it after this); `result` is then its text."""
        if self._disabled or name in TRACKING_TOOLS:
            return
        active = self._active
        if active is None or active["tool_name"] != name:
            return
        self._active = None

        try:
            payload = self._result_text(result)
            if name in CARD_MUTATING_TOOLS and payload is not None:
                self._extract_card_ids(name, payload, active["cards_affected"])

            duration = round(time.monotonic() - active["start_mono"], 3)
            completed_at = datetime.now(timezone.utc).isoformat()
            result_summary = payload[:MAX_RESULT_SUMMARY] if payload is not None else None

            if error is not None:
                # `str(RuntimeError())` is blank; the type name keeps a reason on the row.
                reason = str(error) or type(error).__name__
                status, error_message = "failed", reason[:MAX_RESULT_SUMMARY]
            else:
                status, error_message = self._classify_result(payload)
                if isinstance(result, CallToolResult) and result.isError:
                    status = "failed"
                    error_message = error_message or payload or "Tool call failed"
                    error_message = error_message[:MAX_RESULT_SUMMARY]

            patch_body: dict = {
                "status": status,
                "tools_used": [name],
                "cards_affected": sorted(active["cards_affected"]),
                "tool_calls_count": 1,
                "duration_seconds": duration,
            }
            if error_message:
                patch_body["error_message"] = error_message
            execution_id = active["execution_id"]
            try:
                await self._client.patch(
                    f"/agents/{self._agent_id}/executions/{execution_id}", patch_body
                )
            except Exception:
                logger.debug("Failed to finalize execution %s", execution_id)

            invocation = {
                "tool_name": name,
                "arguments_summary": active["arguments_summary"],
                "started_at": active["started_at"],
                "completed_at": completed_at,
                "duration_seconds": duration,
                "result_summary": result_summary,
                "status": status,
                "position": 0,
            }
            if error_message:
                invocation["error_message"] = error_message
            try:
                await self._client.post(
                    f"/agents/{self._agent_id}/executions/{execution_id}/tool-invocations",
                    [invocation],
                )
            except Exception:
                logger.debug("Failed to flush invocation for %s", execution_id)
        except Exception:
            pass

    @staticmethod
    def _result_text(result: Any) -> str | None:
        """Text payload of a tool result in any shape the tool manager returns.

        `FuncMetadata.convert_result` yields `list[ContentBlock]` (no output
        schema — every tool here), `(list[ContentBlock], dict)` (output
        schema) or a passthrough `CallToolResult`; a plain `str` arrives from
        direct calls and the wrapper's exception path. TextContent texts are
        newline-joined in order, non-text blocks skipped; no text → None.
        Anything unrecognised also yields None (no payload to inspect).
        """
        if isinstance(result, str):
            return result
        if isinstance(result, tuple):
            result = result[0] if result else None
        elif isinstance(result, CallToolResult):
            result = result.content
        if not isinstance(result, list):
            return None
        texts = [block.text for block in result if isinstance(block, TextContent)]
        return "\n".join(texts) if texts else None

    @staticmethod
    def _classify_result(result: Any) -> tuple[str, str | None]:
        """Detect handle_api_errors' error payload shape in the result text.

        handle_api_errors (errors.py) never raises on an httpx error — it
        returns a JSON *string* like `{"error": true, "status": 422,
        "message": "...", "error_code": "..."}`. The manager boundary promotes
        this explicit failure to a protocol error while preserving its receipt.

        The signal is `"error"` being literally `True`, not merely truthy:
        `create_workspace` reports a duplicate slug as `{"error": "<message>",
        "existing": {...}}` — a *successful* idempotent no-op that returns the
        existing entity, which must stay "completed". Every handle_api_errors
        branch emits the boolean, so `is True` separates the two cleanly.
        """
        if not isinstance(result, str):
            return "completed", None
        try:
            data = json.loads(result)
        except Exception:
            return "completed", None
        if not isinstance(data, dict) or data.get("error") is not True:
            return "completed", None

        parts = []
        if status := data.get("status"):
            parts.append(str(status))
        if message := data.get("message"):
            parts.append(str(message))
        if error_code := data.get("error_code"):
            parts.append(str(error_code))
        return "failed", " ".join(parts) if parts else "Tool call failed"

    def _extract_card_ids(self, name: str, result_json: str, sink: set[str]) -> None:
        try:
            data = json.loads(result_json)
        except Exception:
            return
        if name == "bulk_create_cards":
            for card in data.get("cards", []):
                if card_id := card.get("id"):
                    sink.add(str(card_id))
        elif card_id := data.get("id"):
            sink.add(str(card_id))

    async def finalize(self, status: str = "completed", error: str | None = None) -> None:
        """Shutdown hook — finalize any in-flight call as aborted.

        In per-call mode, a row should be open only if a tool call is
        still executing at shutdown, which is an aborted state from the
        execution's perspective.
        """
        active = self._active
        if self._disabled or active is None:
            self._active = None
            return
        self._active = None
        try:
            patch_body = {
                "status": "aborted" if status == "completed" else status,
                "tools_used": [active["tool_name"]],
                "cards_affected": sorted(active["cards_affected"]),
                "tool_calls_count": 1,
                "duration_seconds": round(time.monotonic() - active["start_mono"], 3),
            }
            if error:
                patch_body["error_message"] = error
            await self._client.patch(
                f"/agents/{self._agent_id}/executions/{active['execution_id']}",
                patch_body,
            )
        except Exception:
            logger.debug("Failed to abort execution %s", active.get("execution_id"))


def normalize_tool_result(result: Any) -> Any:
    """Promote explicit JSON failures without changing their receipt or direct tool API."""
    status, _ = ExecutionTracker._classify_result(ExecutionTracker._result_text(result))
    if status != "failed":
        return result
    if isinstance(result, CallToolResult):
        return result.model_copy(update={"isError": True})
    if isinstance(result, tuple):
        content, structured = result
        return CallToolResult(content=content, structuredContent=structured, isError=True)
    if isinstance(result, list):
        return CallToolResult(content=result, isError=True)
    # Raw values come from direct manager calls with convert_result=False.
    return result
