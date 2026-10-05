# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Reading tool results: their text, whether they failed, and the protocol flag."""

from __future__ import annotations

import json
from typing import Any

from mcp.types import CallToolResult, TextContent


def result_text(result: Any) -> str | None:
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


def classify_result(text: str | None) -> tuple[str, str | None]:
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
    if not isinstance(text, str):
        return "completed", None
    try:
        data = json.loads(text)
    except (ValueError, RecursionError):
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


def normalize_tool_result(result: Any) -> Any:
    """Promote explicit JSON failures without changing their receipt or direct tool API."""
    status, _ = classify_result(result_text(result))
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
