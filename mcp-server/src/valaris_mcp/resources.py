# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.server import AppContext, mcp


@mcp.resource("valaris://workspaces")
async def workspaces_resource(ctx: Context) -> str:
    """List of all accessible workspaces with slugs and metadata."""
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.client.get("/workspaces")
    return json.dumps(result, indent=2, default=str)


@mcp.resource("valaris://workspace/{workspace_slug}/summary")
async def workspace_summary_resource(workspace_slug: str, ctx: Context) -> str:
    """Workspace aggregate stats: board, card, note, channel counts and recent activity."""
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/summary")
    return json.dumps(result, indent=2, default=str)


@mcp.resource("valaris://workspace/{workspace_slug}/board/{board_id}/definition")
async def board_definition_resource(workspace_slug: str, board_id: str, ctx: Context) -> str:
    """Board definition document with scope and structured project content."""
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.board(workspace_slug, board_id)}/definitions")
    return json.dumps(result, indent=2, default=str)
