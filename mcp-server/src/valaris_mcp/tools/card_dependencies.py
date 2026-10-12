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
    """Make card_id depend on depends_on_card_id; the scheduler holds it until the prerequisite completes. Idempotent. See docs.

    Args:
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
    """Remove a depends-on edge; idempotent.

    Args:
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
    """List a card's edges both ways: depends_on (prerequisites) and blocks (dependents).

    Args:
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
    """Check a board's dependency graph (read-only) for cycles, conflicts and orphans; ok=True when clean. See docs.

    Args:
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
    """Report whether a card is unblocked (every prerequisite meets its completion policy) and what still blocks it. See docs.

    Args:
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
    """Fetch a card's latest review verdict (decision, reasoning); 404 when it has none.

    Args:
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
    """Atomically replace a card's whole depends-on set; cycles reject the call and leave the existing edges. See docs.

    Args:
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
        depends_on_card_ids: Full prerequisite list (UUIDs or id prefixes); [] clears it.
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
