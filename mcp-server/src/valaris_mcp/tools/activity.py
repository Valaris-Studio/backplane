# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def list_activity(
    workspace_slug: str,
    board_id: str | None = None,
    limit: int = 50,
    entity_type: str | None = None,
    action: str | None = None,
    search: str | None = None,
    ctx: Context = None,
) -> str:
    """Query a workspace's or board's activity log, newest first.

    Args:
        workspace_slug: Workspace slug.
        board_id: Scope to one board.
        limit: 1-100, default 50.
        entity_type: Activity entity_type; see ENUMS in the server instructions.
        action: Activity action; see ENUMS in the server instructions.
        search: Free-text over summaries.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client

    if board_id:
        path = f"{client.board(workspace_slug, board_id)}/history"
    else:
        path = f"{client.ws(workspace_slug)}/history"

    params = {"limit": limit}
    if entity_type is not None:
        params["entity_type"] = entity_type
    if action is not None:
        params["action"] = action
    if search is not None:
        params["search"] = search

    result = await client.get(path, **params)
    return json.dumps(result, indent=2, default=str)
