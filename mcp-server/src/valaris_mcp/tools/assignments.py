# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def next_assignment(
    workspace_slug: str,
    agent_id: str,
    role_override: str | None = None,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Atomically reserve the next eligible card for a pipeline runner; role filters, untyped-column exclusion and role preconditions are applied server-side.

    Returns card, board, column, repo, effective role, stage_action and a reservation (id + expires_at; auto-expires so a crashed runner cannot starve the board), or {"status": "no_work"} (sleep, retry). Idempotent while reserved; 409 = in-flight execution on another card (403 owner not a member, 404 unknown runner).

    Args:
        workspace_slug: Workspace slug.
        agent_id: Runner UUID.
        role_override: A role the runner holds in its team, instead of its primary.
        board_id: Restrict the scan to one board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {}
    if role_override is not None:
        body["role_override"] = role_override
    if board_id is not None:
        body["board_id"] = board_id

    path = f"/workspaces/{workspace_slug}/agents/{agent_id}/next-assignment"
    resp = await client.request_raw("POST", path, json=body)

    if resp.status_code == 204:
        return json.dumps(
            {
                "status": "no_work",
                "_hint": (
                    "No card is eligible for this runner right now. Sleep "
                    "60-120s before retrying, or wait for a WS event."
                ),
            },
            indent=2,
        )

    result = resp.json()
    result["_hint"] = (
        f"Reserved card {result['card']['id']} for role {result['role']}. "
        f"The reservation expires at {result['reservation']['expires_at']}. "
        f"Call log_execution_start with action={result['stage_action']!r} "
        f"to convert the reservation into a tracked execution."
    )
    return json.dumps(result, indent=2, default=str)
