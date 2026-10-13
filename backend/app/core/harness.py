# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Coding-agent harness identifiers shared by capture and MCP invocations.

The registry only supplies display names. Any well-formed identifier is
accepted, so capturing a new harness never waits on a backend release.
"""

import hashlib
from typing import Annotated, Literal, get_args

from pydantic import StringConstraints

HARNESS_PATTERN = r"^[a-z][a-z0-9_]{1,63}$"
HarnessName = Annotated[str, StringConstraints(pattern=HARNESS_PATTERN)]

# Harness-assigned ids (session ids, tool call ids) are opaque but must stay
# safe to index, log and put in a URL. Pi on OpenAI joins two ids with `|`.
NATIVE_ID_MAX = 200
NATIVE_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:@/+=|-]{0,199}$"
NativeId = Annotated[str, StringConstraints(pattern=NATIVE_ID_PATTERN)]


def native_call_key(call_id: str) -> str:
    """A tool call id as stored and matched: verbatim when it fits, otherwise
    a stable hash (Pi's OpenAI ids run to 400+ characters). Must equal
    mcp-server/src/valaris_mcp/native_context.py native_call_key."""
    if len(call_id) <= NATIVE_ID_MAX:
        return call_id
    return "sha256:" + hashlib.sha256(call_id.encode()).hexdigest()


CollectionMethod = Literal["hook", "otlp", "plugin", "poll"]
COLLECTION_METHODS = frozenset(get_args(CollectionMethod))

# Beacon's harness.name values.
KNOWN_HARNESSES: dict[str, str] = {
    "claude_code": "Claude Code",
    "codex_cli": "Codex CLI",
    "codex_desktop": "Codex Desktop",
    "pi_cli": "Pi",
}


# Harnesses that are one agent to the outside world. Every Codex host
# introduces itself to MCP servers as `codex-mcp-client`, so an MCP invocation
# says codex_cli even when Beacon captured the session as codex_desktop.
# Unlisted harnesses are their own family.
HARNESS_FAMILIES: dict[str, str] = {"codex_desktop": "codex_cli"}


def harness_family(harness: str) -> str:
    return HARNESS_FAMILIES.get(harness, harness)


def harnesses_in_family(harness: str) -> set[str]:
    family = harness_family(harness)
    return {family} | {
        member for member, root in HARNESS_FAMILIES.items() if root == family
    }


def harness_enabled(harness: str, enabled_agents: list[str] | None) -> bool:
    """enabled_agents names integrations, so a harness follows its family's
    switch: Codex Desktop is captured exactly when codex_cli is enabled."""
    return harness_family(harness) in (enabled_agents or [])


def harness_display_name(harness: str) -> str:
    return KNOWN_HARNESSES.get(harness, harness.replace("_", " ").title())
