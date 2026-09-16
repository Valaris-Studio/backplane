# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _columns_path(slug: str, board_id: str) -> str:
    return f"/workspaces/{slug}/boards/{board_id}/columns"


@mcp.tool()
@handle_api_errors
async def create_column(
    workspace_slug: str,
    board_id: str,
    name: str,
    column_type: str | None = None,
    color: str | None = None,
    ctx: Context = None,
) -> str:
    """Create a column at the end of a board.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        name: Display name.
        column_type: backlog|active|review|done|blocked; drives runner discovery and movement.
        color: Hex color for the header.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {"name": name}
    if column_type is not None:
        body["column_type"] = column_type
    if color is not None:
        body["color"] = color
    result = await client.post(_columns_path(workspace_slug, board_id), body)
    result["_hint"] = "Column created. Use create_card with this column's id to add cards, or create_column to add more columns."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_column(
    workspace_slug: str,
    board_id: str,
    column_id: str,
    name: str | None = None,
    color: str | None = None,
    column_type: str | None = None,
    ctx: Context = None,
) -> str:
    """Update column fields; only provided fields change.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        column_id: Column UUID.
        name: New display name.
        color: New hex color.
        column_type: backlog|active|review|done|blocked, or "null" to clear the
            type and make the column human-only (runners skip it).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {}
    if name is not None:
        body["name"] = name
    if color is not None:
        body["color"] = color
    if column_type is not None:
        # Sentinel values that mean "clear the type." Plain empty string also
        # works for callers that find "null" more natural than None through
        # a string-typed tool argument.
        if column_type.lower() in ("null", "none", ""):
            body["column_type"] = None
        else:
            body["column_type"] = column_type
    path = f"{_columns_path(workspace_slug, board_id)}/{column_id}"
    result = await client.patch(path, body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_column(
    workspace_slug: str, board_id: str, column_id: str, ctx: Context
) -> str:
    """Delete a column and all its cards permanently.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        column_id: Column UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_columns_path(workspace_slug, board_id)}/{column_id}"
    await client.delete(path)
    return f"Column {column_id} deleted successfully"


@mcp.tool()
@handle_api_errors
async def reorder_columns(
    workspace_slug: str,
    board_id: str,
    column_ids: list[str],
    ctx: Context = None,
) -> str:
    """Reorder a board's columns. Send every column UUID on the board in the new left-to-right order; foreign ids are rejected and omitted columns keep their positions.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        column_ids: All column UUIDs on the board, in order.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_columns_path(workspace_slug, board_id)}/reorder"
    result = await client.patch(path, {"column_ids": column_ids})
    return json.dumps(result, indent=2, default=str)
