# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fuzzy correlation of MCP invocations whose harness sent no native call id.

Pi's MCP extensions drop Pi's tool call id (until pi-mcp-adapter forwards it
as `pi-mcp-adapter/toolCallId`), so an invocation from Pi can only be tied to
a captured tool call by what the call looked like: the same tool, the same
arguments and nearly the same time. Both sides are reduced to one signature
per candidate tool name:

    sha256(canonical_json([digest(tool name), arguments fingerprint]))

Strings are compared by the companion's metadata-level digest, so a session
captured at any content level produces the same signature. Any other change
the companion makes to arguments (home paths, secret redaction, truncation)
yields a different signature and so no link, never a wrong one.
"""

import hashlib
import json
import re
from datetime import timedelta
from typing import Any

# Harnesses whose MCP clients may send no call id at all.
CORRELATED_HARNESSES = frozenset({"pi_cli"})

# The companion stamps a Pi hook when it fires (the capture's captured_at),
# the MCP server stamps the call when it starts and ends; both run on the
# user's machine. Covers hook dispatch, lazy MCP server start-up and a
# remote MCP server's NTP skew, and stays short enough that an identical
# call repeated by the agent a little later is a second candidate.
CORRELATION_WINDOW = timedelta(seconds=10)

# pi-mcp-adapter connects as `pi-mcp-<configured server name>`.
PI_ADAPTER_CLIENT_PREFIX = "pi-mcp-"
# pi-mcp-adapter's `mcp` proxy tool and its `mcp__<server>` namespace tools
# take the MCP tool's name and arguments as `{tool, args}`.
PI_PROXY_TOOL = "mcp"
PI_NAMESPACE_TOOL_PREFIX = "mcp__"

_DIGEST_PREFIX = "[omitted "


def _digest(text: str) -> str:
    """companion/internal/privacy digestStrings, for one string."""
    if text.startswith(_DIGEST_PREFIX):
        return text
    encoded = text.encode("utf-8", "surrogatepass")
    short_hash = hashlib.sha256(encoded).hexdigest()[:16]
    return f"{_DIGEST_PREFIX}{len(encoded)} bytes sha256:{short_hash}]"


def _digested(value: Any) -> Any:
    if isinstance(value, str):
        return _digest(value)
    if isinstance(value, dict):
        return {key: _digested(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_digested(child) for child in value]
    # JSON round trips through Go and JS turn 3.0 into 3.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def _canonical_sha256(value: Any) -> str:
    canonical = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str
    )
    return hashlib.sha256(canonical.encode("utf-8", "surrogatepass")).hexdigest()


def arguments_fingerprint(arguments: Any) -> str:
    """Must equal mcp-server/src/valaris_mcp/native_context.py arguments_fingerprint."""
    return _canonical_sha256(_digested(arguments or {}))


def _signature(tool_name: str, fingerprint: str) -> str:
    return _canonical_sha256([_digest(tool_name), fingerprint])


_UNREADABLE = object()


def _proxied_arguments(arguments: Any) -> Any:
    # The adapter parses string args as JSON; a digested string cannot be.
    if not isinstance(arguments, str):
        return arguments
    if not arguments.strip():
        return {}
    try:
        return json.loads(arguments)
    except ValueError:
        return _UNREADABLE


def captured_call_signature(harness: str, event: dict) -> str | None:
    """Signature of the MCP call a captured tool event made, if it can have one."""
    if harness not in CORRELATED_HARNESSES:
        return None
    tool = event.get("tool")
    raw = event.get("raw")
    pi = raw.get("pi") if isinstance(raw, dict) else None
    tool_name = tool.get("name") if isinstance(tool, dict) else None
    arguments = pi.get("input") if isinstance(pi, dict) else None
    if not isinstance(tool_name, str) or not isinstance(arguments, dict):
        return None
    is_proxy = tool_name == PI_PROXY_TOOL or tool_name.startswith(
        PI_NAMESPACE_TOOL_PREFIX
    )
    if is_proxy and isinstance(arguments.get("tool"), str):
        tool_name = arguments["tool"]
        arguments = _proxied_arguments(arguments.get("args"))
        if arguments is not None and not isinstance(arguments, dict):
            return None
    return _signature(tool_name, arguments_fingerprint(arguments))


def _sanitized_server(server: str) -> str:
    """pi-mcp-adapter sanitizeServerPrefix."""
    return "".join(
        char
        if char.isascii() and (char.isalnum() or char in "_-")
        else f"_{ord(char):x}_"
        for char in server
    )


def _pi_tool_names(tool_name: str, client_name: str | None) -> set[str]:
    """Every name pi-mcp-adapter may give this MCP tool (types.ts formatToolName)."""
    base = tool_name.replace(".", "_")
    names = {tool_name, base}
    if not client_name or not client_name.startswith(PI_ADAPTER_CLIENT_PREFIX):
        return names
    server = client_name[len(PI_ADAPTER_CLIENT_PREFIX) :]
    short = (
        _sanitized_server(re.sub(r"-?mcp$", "", server, flags=re.IGNORECASE)) or "mcp"
    )
    for prefix in {
        _sanitized_server(server),
        short,
        "mcp__" + _sanitized_server(server),
    }:
        names.add(base if base.startswith(prefix + "_") else f"{prefix}_{base}")
    return names


def invocation_signatures(
    tool_name: str, client_name: str | None, fingerprint: str
) -> set[str]:
    return {
        _signature(name, fingerprint) for name in _pi_tool_names(tool_name, client_name)
    }
