# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def request_approval(
    workspace_slug: str,
    category: str,
    action_description: str,
    action_payload: dict,
    agent_id: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Request human approval for a high-impact action, then poll get_approval_status.

    Args:
        workspace_slug: Workspace slug.
        category: deletion|bulk_change|deployment|schema_change|permission_change|external_action.
        action_description: What will happen, for humans.
        action_payload: JSON of the action to run if approved.
        agent_id: Requesting runner UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {
        "category": category,
        "action_description": action_description,
        "action_payload": action_payload,
        "agent_id": agent_id,
    }
    if board_id is not None:
        body["board_id"] = board_id
    result = await client.post(f"{client.ws(workspace_slug)}/approvals", body)
    result["_hint"] = (
        "Poll get_approval_status until status is approved or rejected."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_approvals(
    workspace_slug: str,
    status: str | None = None,
    ctx: Context = None,
) -> str:
    """List a workspace's approval requests.

    Args:
        workspace_slug: Workspace slug.
        status: pending|approved|rejected|expired|auto_approved.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params = {}
    if status is not None:
        params["status"] = status
    result = await client.get(f"{client.ws(workspace_slug)}/approvals", **params)
    return json.dumps(
        {
            "approvals": result,
            "count": len(result),
            "_hint": "Act on a pending approval with decide_approval(approval_id, decision).",
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def get_approval_status(
    workspace_slug: str,
    approval_id: str,
    ctx: Context = None,
) -> str:
    """Check an approval request's status (pending|approved|rejected|expired|auto_approved).

    Args:
        workspace_slug: Workspace slug.
        approval_id: Approval UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/approvals/{approval_id}")
    status = result.get("status", "unknown")
    hints = {
        "pending": "Approval is still pending. Poll again after a short delay.",
        "approved": "Approved! Proceed with the action described in the approval request.",
        "rejected": "Rejected. Do NOT proceed. Inform the user and suggest alternatives.",
        "expired": "Approval expired before a decision was made. Submit a new request if still needed.",
        "auto_approved": "Auto-approved by policy. Proceed with the action.",
    }
    result["_hint"] = hints.get(status, f"Unknown status '{status}'. Check the approval details.")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def decide_approval(
    workspace_slug: str,
    approval_id: str,
    decision: str,
    reason: str | None = None,
    ctx: Context = None,
) -> str:
    """Approve or reject a pending approval request.

    Args:
        workspace_slug: Workspace slug.
        approval_id: Approval UUID.
        decision: approved|rejected.
        reason: Optional reason.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {"decision": decision}
    if reason is not None:
        body["reason"] = reason
    result = await client.post(
        f"{client.ws(workspace_slug)}/approvals/{approval_id}/decide", body
    )
    if decision == "approved":
        result["_hint"] = "Approval granted. The requesting runner can now proceed with the action."
    else:
        result["_hint"] = "Approval rejected. The requesting runner will be notified and should not proceed."
    return json.dumps(result, indent=2, default=str)
