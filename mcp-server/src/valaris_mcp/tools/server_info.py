# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import logging

import httpx
from mcp.server.fastmcp import Context

from valaris_mcp.allowlist import ALLOWLIST_ENV, listed_tools
from valaris_mcp.catalog import (
    DEPRECATION_REMOVAL_VERSION,
    compact_listing_bytes,
    deprecated_aliases,
    live_tool_names,
)
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.hand import HandState, listed_layer
from valaris_mcp.server import AppContext, mcp, server_version
from valaris_mcp.toolsets import ALL, DEFAULT, DEFAULT_TOOLSET_IDS, TOOLSETS_ENV, toolset_catalog

logger = logging.getLogger(__name__)

# Rough tokenizer-agnostic heuristic for the listing census.
_BYTES_PER_TOKEN = 4

_TOOLSETS_HINT = (
    "Call enable_toolsets(toolset_ids=[...]) to widen this session's hand at runtime "
    f"(`{ALL}`, `{DEFAULT}`, or any id under toolsets.available); {TOOLSETS_ENV} in the "
    "server env only picks the initial hand. Notification delivery does not confirm "
    "client discovery; if tools remain missing, use enable_toolsets.restart_env "
    "in the MCP server startup configuration, restart it and start a new agent session."
)
_ALLOWLIST_IS_THE_HAND_HINT = (
    f"{ALLOWLIST_ENV} is set and {TOOLSETS_ENV} is not, so every toolset is loaded "
    "and the allowlist alone picks the hand — enable_toolsets has nothing to add and "
    f"never lifts the allowlist. Set {TOOLSETS_ENV} to narrow the initial hand."
)
_WIDENED_HINT = (
    "The server hand grew: clients that support refresh can re-list tools (tools/list). "
    "Widening is one-way for this session; the allowlist is never lifted."
)
_NOTIFICATION_FAILED_HINT = (
    "The hand grew but the tools/list_changed notification could not be sent: "
    "a client that supports refresh can re-list tools (tools/list)."
)
_NOTHING_ADDED_HINT = (
    "Nothing new to list: the requested toolsets were already in the hand, or the "
    "allowlist clips them (see allowlist_clipped). No notification was sent."
)

_CLIENT_CATALOG_HINT = (
    "Notification delivery does not confirm client catalog refresh. If the added tools "
    "are still absent, apply restart_env to the MCP SERVER startup configuration, "
    "restart the MCP server/connection, then start a new agent session. For remote HTTP, "
    "the server operator must apply that environment; client env cannot change it. "
    "Keep VALARIS_MCP_ALLOWLIST unchanged. Restarting without updating startup toolsets "
    "loses this session's widening."
)


def _registered_tool_names() -> list[str]:
    # The full registry, not `list_tools()` — the hand filters listing, and
    # `tools` must keep meaning the whole surface. Deprecated aliases are
    # reported apart so tool_count describes the live surface.
    return sorted(live_tool_names())


def _annotated_tool_count() -> int:
    registry = mcp._tool_manager._tools
    return sum(1 for name in live_tool_names() if registry[name].annotations is not None)


async def _session_listing(hand: HandState) -> list:
    # Filter here rather than trusting `mcp.list_tools()`: the hand wrapper is
    # only installed by the lifespan, and a direct call must report the same
    # hand the wire would.
    return listed_tools(await mcp.list_tools(), hand.composed)


def _allowlist_is_the_hand(hand: HandState) -> bool:
    return hand.toolset_ids is None and hand.allowlist is not None


@mcp.tool()
@handle_api_errors
async def get_server_info(ctx: Context = None) -> str:
    """Report this server's version, full tool surface, and the hand enabled in
    THIS session; call it when a tool seems missing (version, toolset or
    allowlist drift).

    Returns version, tools/tool_count (full live surface even when filtered;
    deprecated_aliases lists retired names still callable until
    deprecated_removed_in, allowlist_deprecated the granted ones),
    allowlist, toolsets (loaded ids; resolved_tool_count = the toolset hand
    BEFORE the allowlist intersection; default, available ids, hint to widen),
    enabled_tools (registered ∩ toolsets ∩ allowlist; allowlist entries this
    server lacks under allowlist_unknown, entries clipped by the loaded
    toolsets under allowlist_outside_toolsets), listing_bytes/
    listing_tokens_estimate (compact size of this session's tools/list;
    tokens ≈ bytes/4), annotated_tools, backend reachability (GET /api/health).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    hand = app.hand

    tools = _registered_tool_names()
    toolset_hand, allowlist, composed = hand.toolset_hand, hand.allowlist, hand.composed
    listing_bytes = compact_listing_bytes(await _session_listing(hand))
    widen_hint = _ALLOWLIST_IS_THE_HAND_HINT if _allowlist_is_the_hand(hand) else _TOOLSETS_HINT

    info: dict = {
        "version": server_version(),
        "tools": tools,
        "tool_count": len(tools),
        "deprecated_aliases": deprecated_aliases(),
        "deprecated_removed_in": DEPRECATION_REMOVAL_VERSION,
        "annotated_tools": _annotated_tool_count(),
        "allowlist": sorted(allowlist) if allowlist is not None else None,
        "toolsets": {
            "loaded": hand.toolset_ids if hand.toolset_ids is not None else [ALL],
            "resolved_tool_count": len(tools) if toolset_hand is None else len(toolset_hand),
            "default": list(DEFAULT_TOOLSET_IDS),
            "available": [
                {k: entry[k] for k in ("id", "kind", "group", "tool_count")}
                for entry in toolset_catalog()
            ],
            "hint": widen_hint,
        },
        "listing_bytes": listing_bytes,
        "listing_tokens_estimate": round(listing_bytes / _BYTES_PER_TOKEN),
    }

    aliases = deprecated_aliases()
    registered = set(tools) | set(aliases)
    # A granted alias is still callable, so it is enabled — the listing must
    # keep meaning "what this session can call".
    info["enabled_tools"] = tools if composed is None else sorted(registered & composed)
    tool_set = set(tools)
    if allowlist is not None:
        granted_aliases = {name: aliases[name] for name in sorted(allowlist & set(aliases))}
        if granted_aliases:
            # A stored grant (loop_config.tools / pipeline llm.tools) still
            # names a retired tool: it works until deprecated_removed_in.
            info["allowlist_deprecated"] = granted_aliases
        unknown = sorted(allowlist - registered)
        if unknown:
            # Allowlisted names this server doesn't register → version/config
            # drift between the runner's allowlist and the deployed server.
            info["allowlist_unknown"] = unknown
        if toolset_hand is not None:
            clipped = sorted((allowlist & tool_set) - toolset_hand)
            if clipped:
                # Registered and granted, yet unlisted: the loaded toolsets
                # clip them — widen the toolsets, not the allowlist.
                info["allowlist_outside_toolsets"] = clipped

    # Backend health is best-effort: server info is locally computable, so an
    # unreachable API must not fail the whole call — just flag it.
    try:
        health = await client.get("/health")
        info["backend"] = {"reachable": True, "status": health}
    except httpx.HTTPError as e:
        info["backend"] = {"reachable": False, "error": str(e)}

    return json.dumps(info, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def enable_toolsets(toolset_ids: list[str], ctx: Context = None) -> str:
    """Widen THIS session's server tool hand and request client refresh; notification delivery does not prove the client catalog updated.

    Widen-only and idempotent: ids already loaded add nothing and send no
    notification; `all` lifts the toolset layer. A runner allowlist is a
    ceiling this never lifts — names it clips are reported under
    allowlist_clipped. Returns loaded (ids, or ["all"]), added_tools/
    added_count, enabled_tool_count and listing_bytes of this session's
    tools/list, list_changed_sent, client_catalog_status (always unverified),
    and restart_env (server startup environment preserving the current hand).

    Args:
        toolset_ids: Toolset ids to add: all, default, or any group or category id listed under get_server_info.toolsets.available.
    """
    app: AppContext = ctx.request_context.lifespan_context
    hand = app.hand

    toolset_layer_before = hand.toolset_hand
    try:
        added = hand.widen(toolset_ids)
    except ValueError as exc:
        return json.dumps({"error": True, "message": str(exc)}, indent=2)

    listing = await _session_listing(hand)
    list_changed_sent = False
    if added:
        # The widening is already applied; a dead transport must not undo it
        # or turn the result into an error — the client just re-lists by hand.
        try:
            await ctx.session.send_tool_list_changed()
            list_changed_sent = True
        except Exception as exc:
            logger.warning("tools/list_changed notification failed: %s", exc)

    result: dict = {
        "loaded": hand.toolset_ids if hand.toolset_ids is not None else [ALL],
        "added_tools": sorted(added),
        "added_count": len(added),
        "enabled_tool_count": len(listing),
        "listing_bytes": compact_listing_bytes(listing),
        "list_changed_sent": list_changed_sent,
        "client_catalog_status": "unverified",
        "restart_env": {
            TOOLSETS_ENV: ",".join(hand.toolset_ids) if hand.toolset_ids is not None else ALL
        },
    }
    if hand.allowlist is not None and toolset_layer_before is not None:
        # What the toolsets would have added had the allowlist not been there.
        clipped = listed_layer(hand.toolset_hand) - toolset_layer_before - hand.allowlist
        if clipped:
            result["allowlist_clipped"] = sorted(clipped)
    if not added:
        result["_hint"] = _NOTHING_ADDED_HINT
    elif list_changed_sent:
        result["_hint"] = _WIDENED_HINT
    else:
        result["_hint"] = _NOTIFICATION_FAILED_HINT
    result["_hint"] += " " + _CLIENT_CATALOG_HINT
    return json.dumps(result, indent=2, default=str)
