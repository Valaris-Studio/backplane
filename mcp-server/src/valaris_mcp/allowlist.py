# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Server-side MCP tool allowlist enforcement.

Design: docs/pipeline-design/05-mcp-allowlist-enforcement.md §3.

Runner injects `VALARIS_MCP_ALLOWLIST=tool1,tool2,...` into this process's
env. We turn that into a hard gate on `_tool_manager.call_tool` AND a filter
on `_tool_manager.list_tools`, so the model is only told about the tools it
can call (every unlisted schema is dead context). claude-cli's
`--allowedTools` is advisory under `--dangerously-skip-permissions`; this
gate is the load-bearing enforcement seam.

The allowlist is fixed for the lifetime of the process (read once from env at
startup). The toolset layer it composes with is not: `enable_toolsets` widens
it mid-session, which is why `install_hand` reads the composed hand at every
list/call instead of capturing it once.

Back-compat: missing/empty env = no restriction (manual claude sessions,
MCP Inspector, kanban UI direct usage all continue to work unrestricted).

Fail-closed: malformed env vars (tokens that don't look like tool
identifiers) raise on load, so misconfigured deploys surface loudly instead
of silently disabling the gate.

Composition rule: the hand a session sees is `compose_hand(toolset_hand,
allowlist)` — None when neither is set, otherwise the intersection of
whichever are set. Toolsets (`VALARIS_MCP_TOOLSETS`, see toolsets.py) pick a
slice of the surface; the allowlist is the runner's stage grant. A present
allowlist with no toolsets env loads every toolset (toolsets.load_toolsets),
and newer runner binaries pin `all` explicitly, so a stage grant is never
narrowed twice.
"""
from __future__ import annotations

import json
import logging
import os
import re
from typing import TYPE_CHECKING, Any, Iterable, TypeVar

from mcp.server.lowlevel.server import request_ctx

if TYPE_CHECKING:
    from valaris_mcp.hand import HandState

logger = logging.getLogger(__name__)

ALLOWLIST_ENV = "VALARIS_MCP_ALLOWLIST"
_TOOL_NAME_RE = re.compile(r"^[a-z_][a-z0-9_]*$")
_WILDCARD = "*"


def load_allowlist() -> frozenset[str] | None:
    """Parse `VALARIS_MCP_ALLOWLIST` into an enforcement set.

    Returns `None` when there's no restriction (unset, empty, whitespace-only,
    parses to an empty list, or contains the `*` wildcard). Returns a
    `frozenset[str]` to enforce. Raises `RuntimeError` if any token fails the
    tool-name shape check.
    """
    raw = os.environ.get(ALLOWLIST_ENV)
    if raw is None:
        return None
    parts = [p.strip() for p in raw.split(",") if p.strip()]
    if not parts:
        return None
    # `*` is the universal "allow all" token operators reach for in hand-written
    # run.sh / .mcp.json templates. Honour it as "no restriction" BEFORE the
    # regex check — otherwise it fails the tool-name shape and crashes startup.
    if _WILDCARD in parts:
        return None
    invalid = [p for p in parts if not _TOOL_NAME_RE.match(p)]
    if invalid:
        raise RuntimeError(
            f"{ALLOWLIST_ENV} contains invalid tool names: {invalid!r}"
        )
    return frozenset(parts)


_NamedT = TypeVar("_NamedT")


def listed_tools(tools: Iterable[_NamedT], allowlist: frozenset[str] | None) -> list[_NamedT]:
    """The tools a session with `allowlist` gets to see, in registration order.

    `None` means unrestricted. The runner's deny-all sentinel parses to
    `frozenset({"__none__"})`, which matches no tool and therefore lists [].
    """
    if allowlist is None:
        return list(tools)
    return [tool for tool in tools if tool.name in allowlist]


def compose_hand(
    toolset_hand: frozenset[str] | None, allowlist: frozenset[str] | None
) -> frozenset[str] | None:
    """Intersection of whichever filters are set; None only when both are None.

    A deny-all `frozenset({"__none__"})` allowlist intersects to the empty
    set (lists nothing, denies everything) — never back to unrestricted.
    """
    if toolset_hand is None:
        return allowlist
    if allowlist is None:
        return toolset_hand
    return frozenset(toolset_hand & allowlist)


_HAND_INSTALLED = "_valaris_hand_installed"


def _current_hand(installed: HandState) -> HandState:
    # Under streamable-http every session runs its own lifespan against the
    # one shared tool manager; the request context carries that session's
    # AppContext. No request (stdio startup, direct calls) → install-time hand.
    try:
        lifespan_context = request_ctx.get().lifespan_context
    except LookupError:
        return installed
    return getattr(lifespan_context, "hand", installed)


def install_hand(server: Any, hand: HandState) -> None:
    """Gate `_tool_manager.call_tool` and filter `_tool_manager.list_tools` by the
    calling session's hand.

    Installed at most once per tool manager and resolving the hand per request:
    streamable-http enters the lifespan once PER SESSION on the shared manager, so
    stacking a closure per session would let A's gate nullify B's widening forever.
    An unrestricted hand at install time is a no-op (back-compat: manual sessions,
    Inspector, kanban UI). Both closures read `composed` at call time, so an
    `enable_toolsets` widen shows on the very next list/call. Mirrors
    `install_tracking`'s monkey-patch shape — FastMCP exposes no public middleware
    in the version pinned here. Install order is set in `server.py`: hand first
    (inner), tracking second (outer), so the tracker records denials for
    forensics. The registry itself (`_tools`) is untouched so get_server_info can
    still report the full surface.
    """
    if hand.composed is None:
        return
    manager = server._tool_manager
    if getattr(manager, _HAND_INSTALLED, False):
        return
    setattr(manager, _HAND_INSTALLED, True)
    original = manager.call_tool
    # Listing filter; tolerated absent on call-only manager stubs in tests.
    original_list = getattr(manager, "list_tools", None)
    if original_list is not None:

        def filtered_list():
            return listed_tools(original_list(), _current_hand(hand).composed)

        manager.list_tools = filtered_list

    async def gated(name, arguments, **kwargs):
        current = _current_hand(hand)
        composed = current.composed
        if composed is not None and name not in composed:
            logger.warning(
                "mcp_tool_denied tool=%s allowlist_size=%d",
                name, len(composed),
            )
            denial: dict[str, Any] = {
                "error": "tool_not_allowed",
                "tool": name,
                "allowlist": sorted(composed),
            }
            # Echoed so a denied model knows which slices it holds and can
            # widen; absent once the toolset layer is unrestricted.
            if current.toolset_ids is not None:
                denial["toolsets"] = list(current.toolset_ids)
            raise PermissionError(json.dumps(denial))
        return await original(name, arguments, **kwargs)

    manager.call_tool = gated


def install_allowlist(
    server: Any,
    allowlist: frozenset[str] | None,
    toolsets: list[str] | None = None,
) -> None:
    """Fixed-hand form of `install_hand`: `allowlist` is an already composed
    hand (see `compose_hand`), `toolsets` the ids echoed in denials."""
    from valaris_mcp.hand import HandState  # hand.py imports this module

    install_hand(server, HandState(toolsets, None, allowlist))
