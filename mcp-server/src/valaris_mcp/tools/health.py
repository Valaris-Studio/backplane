# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def get_board_health(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Get a board's computed health: score (0-100), stale/overdue/unassigned cards, priority and column distribution, velocity. Use for triage and standup.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.board(workspace_slug, board_id)}/health")
    return json.dumps(result, indent=2, default=str)
