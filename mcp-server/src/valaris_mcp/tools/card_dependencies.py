# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DEP-5: MCP tools for card dependencies.

Mirrors the REST surface at
  /api/workspaces/{slug}/boards/{board_id}/cards/{card_id}/dependencies

Idempotency: add returns the existing edge as a 200; remove succeeds even
when the edge is missing. Cycle attempts surface as 422 errors from the
backend; the @handle_api_errors decorator turns those into structured
tool errors the LLM can reason about.

`bulk_set_card_dependencies` is the single-call escape hatch for planner
agents that need to declare the whole edge set for a card in one MCP
round-trip — see [[feedback_mcp_update_card_rate_limit]].
"""

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp
from valaris_mcp.tools.cards import _resolve_card_id


def _deps_path(slug: str, board_id: str, card_id: str) -> str:
    return f"/workspaces/{slug}/boards/{board_id}/cards/{card_id}/dependencies"


@mcp.tool()
@handle_api_errors
async def add_card_dependency(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    depends_on_card_id: str,
    ctx: Context = None,
) -> str:
    """Declare that card_id depends on depends_on_card_id, gating scheduler pickup until the prerequisite satisfies its effective completion policy. Idempotent: re-adding returns the existing edge (200); cycles and self-deps are 422.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Dependent card UUID or id prefix.
        depends_on_card_id: Prerequisite card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    resolved_prerequisite = await _resolve_card_id(
        client, workspace_slug, board_id, depends_on_card_id
    )
    path = _deps_path(workspace_slug, board_id, resolved_id)
    result = await client.post(
        path, {"depends_on_card_id": resolved_prerequisite}
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def remove_card_dependency(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    depends_on_card_id: str,
    ctx: Context = None,
) -> str:
    """Remove a depends-on edge. Idempotent: a missing edge is a no-op success.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Dependent card UUID or id prefix.
        depends_on_card_id: Prerequisite card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    resolved_prerequisite = await _resolve_card_id(
        client, workspace_slug, board_id, depends_on_card_id
    )
    path = (
        _deps_path(workspace_slug, board_id, resolved_id)
        + f"/{resolved_prerequisite}"
    )
    await client.delete(path)
    return json.dumps(
        {
            "removed": True,
            "card_id": resolved_id,
            "depends_on_card_id": resolved_prerequisite,
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def list_card_dependencies(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    ctx: Context = None,
) -> str:
    """List a card's dependency edges both ways: depends_on (prerequisites) and blocks (dependents).

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    path = _deps_path(workspace_slug, board_id, resolved_id)
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def validate_board_dependencies(
    workspace_slug: str,
    board_id: str,
    ctx: Context = None,
) -> str:
    """Check a board's whole dependency graph for faults. Read-only. ok=True when clean; otherwise cycles (mutually dependent cards, never eligible), conflicts (done cards with undone prerequisites) and orphans (edges pointing off-board), each with a summary.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"/workspaces/{workspace_slug}/boards/{board_id}/dependencies/validation"
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_card_dependency_status(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    ctx: Context = None,
) -> str:
    """Report whether a card is unblocked: satisfied (every prerequisite meets its effective completion policy), total_prerequisites, blocking (undone prerequisites with title/status/column_type) and blocks_count.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    view = await client.get(_deps_path(workspace_slug, board_id, resolved_id))

    depends_on = view.get("depends_on", []) if isinstance(view, dict) else []
    blocks = view.get("blocks", []) if isinstance(view, dict) else []

    blocking = [
        {
            "card_id": edge.get("depends_on_card_id"),
            "title": edge.get("depends_on_title"),
            "status": edge.get("depends_on_status"),
            "column_type": edge.get("depends_on_column_type"),
        }
        for edge in depends_on
        if not (edge["satisfied"] is True if "satisfied" in edge else edge.get("depends_on_column_type") == "done")
    ]

    result = {
        "card_id": resolved_id,
        "satisfied": len(blocking) == 0,
        "total_prerequisites": len(depends_on),
        "blocking": blocking,
        "blocks_count": len(blocks),
    }
    if blocking:
        titles = ", ".join(b["title"] or b["card_id"] or "?" for b in blocking)
        result["_hint"] = (
            f"Not yet eligible: {len(blocking)} prerequisite(s) still open "
            f"({titles}). The scheduler will not assign this card until they "
            f"satisfy their effective completion policy."
        )
    else:
        result["_hint"] = "All prerequisite completion requirements satisfied — this card is dependency-eligible."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_card_verdict(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    ctx: Context = None,
) -> str:
    """Fetch the latest review verdict on a card (decision and reasoning) before reworking it. 404 when the card has no verdict yet.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    path = (
        f"/workspaces/{workspace_slug}/boards/{board_id}/cards/{resolved_id}/verdict"
    )
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def bulk_set_card_dependencies(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    depends_on_card_ids: list[str],
    ctx: Context = None,
) -> str:
    """Atomically replace a card's whole depends-on set in one call; use it to declare a DAG from the planner stage. The set is validated for cycles and tenancy before anything changes; on rejection existing edges stay.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
        depends_on_card_ids: Complete prerequisite list (UUIDs or id prefixes); empty clears the set.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    resolved_prerequisites = [
        await _resolve_card_id(client, workspace_slug, board_id, prerequisite)
        for prerequisite in depends_on_card_ids
    ]
    path = _deps_path(workspace_slug, board_id, resolved_id)
    result = await client.put(
        path, {"depends_on_card_ids": resolved_prerequisites}
    )
    return json.dumps(result, indent=2, default=str)
