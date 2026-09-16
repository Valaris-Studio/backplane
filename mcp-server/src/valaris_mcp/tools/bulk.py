# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def bulk_create_cards(
    workspace_slug: str,
    board_id: str,
    cards: list[dict],
    ctx: Context = None,
) -> str:
    """Create up to 50 cards on a board in one request. An invalid column_id, unknown git_repo_slug or unknown key rejects the whole batch (422).

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        cards: Each: column_id, title (required); description, card_type
            (task|issue|feature|bug), priority (none|low|medium|high|urgent),
            due_date (YYYY-MM-DD), status, labels, git_repo_slug. Nothing else.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {"cards": cards}
    result = await client.post(f"{client.board(workspace_slug, board_id)}/cards/bulk", body)
    result["_description_format"] = "prosemirror"
    result["_hint"] = f"Created {result.get('created', len(cards))} cards. Descriptions are ProseMirror JSON, not markdown. Preserve your original markdown or use get_card for an editable markdown description before updating. Use get_board to see the updated board."
    return json.dumps(result, indent=2, default=str)
