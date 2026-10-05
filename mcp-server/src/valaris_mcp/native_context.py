# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Which coding agent is calling, and its own id for the current tool call.

A backend correlates an MCP invocation with the coding agent's own record of
the call through the harness and native call id, so these must be the values
the agent itself reports for that call (`gen_ai.tool.call.id`).
Adding a harness means adding its MCP clientInfo name and its request `_meta`
key here; nothing else in the server knows about specific agents.

A harness whose MCP client sends no call id (Pi's extensions, until
pi-mcp-adapter forwards one) gets an arguments fingerprint instead, which the
backend may use to correlate the call, marked as fuzzy provenance.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from mcp.server.lowlevel.server import request_ctx

# MCP `initialize` clientInfo.name → harness name.
CLIENT_HARNESSES = {
    "claude-code": "claude_code",
    # Every Codex host (CLI, TUI, app-server behind Codex Desktop) initializes
    # MCP servers with this one name, so the MCP side cannot tell them apart.
    "codex-mcp-client": "codex_cli",
    # Pi has no MCP client of its own; these are its community extensions
    # (dmmulroy/pi-mcp, irahardianto/pi-mcp-extension).
    "pi": "pi_cli",
    "pi-mcp": "pi_cli",
}

# clientInfo.name prefixes, for clients that name themselves per server:
# nicobailon/pi-mcp-adapter connects as `pi-mcp-<configured server name>`.
CLIENT_HARNESS_PREFIXES = {"pi-mcp-": "pi_cli"}

# Harness → request `_meta` keys carrying its tool-call id, in preference order.
CALL_ID_META_KEYS = {
    # Claude Code's PreToolUse/PostToolUse `tool_use_id`.
    "claude_code": ("claudecode/toolUseId",),
    # Codex's function-call `call_id` (core/src/mcp_tool_call.rs
    # build_mcp_tool_call_request_meta).
    "codex_cli": ("callId",),
    # The `toolCallId` Pi hands the tool's execute(), under the adapter's own
    # `_meta` namespace (it already sends `pi-mcp-adapter/stream-token`).
    "pi_cli": ("pi-mcp-adapter/toolCallId",),
}

# Harnesses whose MCP clients may send no call id at all; only these get an
# arguments fingerprint for the backend's fuzzy correlation.
CORRELATED_HARNESSES = frozenset({"pi_cli"})

# The shapes a harness uses for call ids; Pi on OpenAI joins two with `|`.
_NATIVE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@/+=|-]{0,4095}\Z")
# The backend stores at most this many characters of an id
# (app/core/harness.py NATIVE_ID_MAX).
NATIVE_ID_MAX = 200
MAX_CLIENT_NAME = 200
MAX_CLIENT_VERSION = 64


def _text(value: Any, limit: int) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    # PostgreSQL text cannot hold NUL or lone surrogates.
    cleaned = "".join(
        char for char in value if char != "\x00" and not 0xD800 <= ord(char) <= 0xDFFF
    )
    return cleaned[:limit] or None


def _harness(client_name: str | None) -> str | None:
    if not client_name:
        return None
    if client_name in CLIENT_HARNESSES:
        return CLIENT_HARNESSES[client_name]
    for prefix, harness in CLIENT_HARNESS_PREFIXES.items():
        if client_name.startswith(prefix) and len(client_name) > len(prefix):
            return harness
    return None


# Metadata-level records replace every string with this digest; a string
# already in this form is left alone, so digesting is idempotent.
_DIGEST_PREFIX = "[omitted "


def _digested(value: Any) -> Any:
    if isinstance(value, str):
        if value.startswith(_DIGEST_PREFIX):
            return value
        encoded = value.encode("utf-8", "surrogatepass")
        short_hash = hashlib.sha256(encoded).hexdigest()[:16]
        return f"{_DIGEST_PREFIX}{len(encoded)} bytes sha256:{short_hash}]"
    if isinstance(value, dict):
        return {key: _digested(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_digested(child) for child in value]
    # JSON round trips through Go and JS turn 3.0 into 3.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def arguments_fingerprint(arguments: Any) -> str:
    """Hash of a tool call's arguments that survives metadata-level content:
    strings are compared by their metadata-level digest.
    """
    canonical = json.dumps(
        _digested(arguments or {}),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        default=str,
    )
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()


def native_call_key(call_id: str) -> str:
    """The id as the backend stores it: verbatim when it fits, otherwise a
    stable hash. Must equal backend/app/core/harness.py native_call_key."""
    if len(call_id) <= NATIVE_ID_MAX:
        return call_id
    return "sha256:" + hashlib.sha256(call_id.encode()).hexdigest()


def native_context(client_info: Any, meta: Any, arguments: Any = None) -> dict[str, str | None]:
    client_name = _text(getattr(client_info, "name", None), MAX_CLIENT_NAME)
    harness = _harness(client_name)
    call_id = None
    for key in CALL_ID_META_KEYS.get(harness, ()):
        candidate = getattr(meta, key, None) if meta is not None else None
        if isinstance(candidate, str) and _NATIVE_ID.match(candidate):
            call_id = native_call_key(candidate)
            break
    context = {
        "harness": harness,
        "native_call_id": call_id,
        "client_name": client_name,
        "client_version": _text(getattr(client_info, "version", None), MAX_CLIENT_VERSION),
    }
    if harness in CORRELATED_HARNESSES and call_id is None:
        context["arguments_fingerprint"] = arguments_fingerprint(arguments)
    return context


def request_native_context(arguments: Any = None) -> dict[str, str | None]:
    """Native context of the tool call being served; empty outside a request."""
    try:
        ctx = request_ctx.get()
    except LookupError:
        return {}
    params = getattr(ctx.session, "client_params", None)
    return native_context(getattr(params, "clientInfo", None), ctx.meta, arguments)
