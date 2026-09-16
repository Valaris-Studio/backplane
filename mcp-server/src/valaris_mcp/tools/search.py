# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def search_cards(
    workspace_slug: str,
    board_id: str,
    q: str | None = None,
    priority: str | None = None,
    card_type: str | None = None,
    status: str | None = None,
    label: str | None = None,
    has_assignee: bool | None = None,
    assignee_id: str | None = None,
    column_id: str | None = None,
    column_type: str | None = None,
    exclude_column_type: str | None = None,
    include_untyped: bool | None = None,
    overdue: bool | None = None,
    summary_only: bool = False,
    limit: int = 50,
    ctx: Context = None,
) -> str:
    """Search and filter cards on a board by text, priority, type, status, label, assignee, column, column type, or overdue.

    Use summary_only=True to browse or triage (full cards carry descriptions and participants and overflow on busy boards), then get_card for the one you need. Both modes include column_name and column_type.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        q: Text to match in titles and descriptions.
        priority: none|low|medium|high|urgent.
        card_type: task|issue|feature|bug.
        status: Status string.
        label: Cards carrying this label.
        has_assignee: True = has a hero, False = unassigned.
        assignee_id: Participant user/runner UUID.
        column_id: Column UUID.
        column_type: backlog|active|review|done|blocked.
        exclude_column_type: Exclude columns of this type.
        include_untyped: Include untyped (human-only) columns; default True. Pass
            False when picking work to execute.
        overdue: True for cards past their due date.
        summary_only: Drop description/participants/derived fields.
        limit: 1-100, default 50.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params = {"limit": limit}
    if q is not None:
        params["q"] = q
    if priority is not None:
        params["priority"] = priority
    if card_type is not None:
        params["card_type"] = card_type
    if status is not None:
        params["status"] = status
    if label is not None:
        params["label"] = label
    if has_assignee is not None:
        params["has_assignee"] = str(has_assignee).lower()
    if assignee_id is not None:
        params["assignee_id"] = assignee_id
    if column_id is not None:
        params["column_id"] = column_id
    if column_type is not None:
        params["column_type"] = column_type
    if exclude_column_type is not None:
        params["exclude_column_type"] = exclude_column_type
    if include_untyped is not None:
        params["include_untyped"] = str(include_untyped).lower()
    if overdue is not None:
        params["overdue"] = str(overdue).lower()
    if summary_only:
        params["summary_only"] = "true"
    result = await client.get(f"{client.board(workspace_slug, board_id)}/cards/search", **params)
    # Wrap in standard list format
    cards = result if isinstance(result, list) else result.get("items", result)
    output = {"total": len(cards), "cards": cards}
    if not cards:
        hint = "No cards match your search criteria. Try broader filters or use list_cards to see all cards."
        if include_untyped is False and column_type is None:
            hint += (
                " Untyped-column cards were excluded (include_untyped=False). If you are"
                " a user-facing assistant (standup/triage/summary), retry omitting the"
                " flag. If you are an autonomous pipeline runner, the exclusion is"
                " correct — do not retry."
            )
        output["_hint"] = hint
    return json.dumps(output, indent=2, default=str)
