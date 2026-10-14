# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Completion metadata from Codex OTLP results retained by older Beacon builds."""

from dataclasses import dataclass

MAX_DURATION_MS = 2**53 - 1


@dataclass(frozen=True)
class CodexToolResult:
    outcome: str | None
    mcp_server: str | None
    mcp_tool: str | None
    duration_ms: int | None


def codex_tool_result(event: dict) -> CodexToolResult | None:
    harness = event.get("harness")
    if not isinstance(harness, dict) or harness.get("name") not in {
        "codex_cli",
        "codex_desktop",
    }:
        return None
    raw = event.get("raw")
    attributes = raw.get("attributes") if isinstance(raw, dict) else None
    if (
        not isinstance(attributes, dict)
        or attributes.get("event.name") != "codex.tool_result"
    ):
        return None
    success = attributes.get("success")
    outcome = None
    if success is True or (isinstance(success, str) and success == "true"):
        outcome = "succeeded"
    elif success is False or (isinstance(success, str) and success == "false"):
        outcome = "failed"
    server = attributes.get("mcp_server")
    tool = attributes.get("tool_name")
    server = server[:200] if isinstance(server, str) and server else None
    tool = tool[:200] if server and isinstance(tool, str) and tool else None
    duration = attributes.get("duration_ms")
    if isinstance(duration, str) and duration.isascii() and duration.isdecimal():
        duration = int(duration) if len(duration) <= 15 else None
    duration_ms = (
        int(duration)
        if isinstance(duration, (int, float))
        and not isinstance(duration, bool)
        and 0 <= duration <= MAX_DURATION_MS
        else None
    )
    return CodexToolResult(outcome, server, tool, duration_ms)
