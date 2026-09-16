# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _base(slug: str) -> str:
    return f"/workspaces/{slug}/merge-queue"


# State enum mirrored from app/models/agents/merge_queue.py:_MERGE_QUEUE_STATES.
# Closed: queued | merging | merged | conflict | failed |
# blocked_pending_consolidation.


@mcp.tool()
@handle_api_errors
async def list_merge_queue(
    workspace_slug: str,
    merged_within_hours: int | None = None,
    ctx: Context = None,
) -> str:
    """List a workspace's in-flight merge-queue entries (queued, merging, conflict,
    failed, blocked_pending_consolidation); merged ones only with merged_within_hours.

    Args:
        workspace_slug: Workspace slug.
        merged_within_hours: Also include entries merged within 1..720 hours.
    """
    app: AppContext = ctx.request_context.lifespan_context
    params = (
        {"merged_within_hours": merged_within_hours}
        if merged_within_hours is not None
        else {}
    )
    result = await app.client.get(_base(workspace_slug), **params)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_merge_queue_entry(
    workspace_slug: str, entry_id: str, ctx: Context = None
) -> str:
    """Fetch one merge-queue entry.

    Args:
        workspace_slug: Workspace slug.
        entry_id: Entry UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    path = f"{_base(workspace_slug)}/{entry_id}"
    result = await app.client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def enqueue_for_merge(
    workspace_slug: str, card_id: str, ctx: Context = None
) -> str:
    """Re-queue a card's existing merge-queue entry after conflict consolidation;
    idempotent, 404 if the card has no entry.

    Args:
        workspace_slug: Workspace slug.
        card_id: Original (parent) card UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    path = f"{_base(workspace_slug)}/re-enqueue"
    result = await app.client.post(path, {"card_id": card_id})
    if isinstance(result, dict):
        result.setdefault(
            "_hint",
            "Card re-queued; the merge worker will retry on its next tick.",
        )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def enqueue_pr_for_merge(
    workspace_slug: str,
    card_id: str,
    git_repo_id: str,
    pr_url: str,
    pr_branch: str,
    integration_branch: str | None = None,
    ctx: Context = None,
) -> str:
    """Enqueue a card's green, self-reviewed PR for the server-side merge queue;
    never run `gh pr merge` yourself.

    The executor rebases and lands it once CI is green and the reconciler moves
    the card to Done. Runner calls need the board loop's
    loop_landing="merge_queue" (else error_code loop_landing_not_enabled).
    Idempotent.

    Args:
        workspace_slug: Workspace slug.
        card_id: Card UUID.
        git_repo_id: Board git repo UUID.
        pr_url: PR URL.
        pr_branch: PR head branch.
        integration_branch: Target branch; defaults to the repo's integration,
            then default, branch.
    """
    app: AppContext = ctx.request_context.lifespan_context
    payload = {
        "card_id": card_id,
        "repo_id": git_repo_id,
        "pr_url": pr_url,
        "pr_branch": pr_branch,
    }
    if integration_branch is not None:
        payload["integration_branch"] = integration_branch
    result = await app.client.post(f"{_base(workspace_slug)}/enqueue", payload)
    if isinstance(result, dict):
        result.setdefault(
            "_hint",
            "Enqueued; the merge worker lands it once CI is green, and the "
            "reconciler moves the card to Done after the merge.",
        )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def cancel_merge_queue_entry(
    workspace_slug: str, entry_id: str, ctx: Context = None
) -> str:
    """Cancel a wedged (conflict/failed) merge-queue entry for human triage
    (admin/owner only); the card is eligible for next_assignment again.

    Args:
        workspace_slug: Workspace slug.
        entry_id: Entry UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    path = f"{_base(workspace_slug)}/{entry_id}/cancel"
    # 204 No Content on success — request_raw, not post(): json() on the
    # empty body raised "Expecting value", reporting failure on success.
    await app.client.request_raw("POST", path)
    result = {
        "status": "cancelled",
        "entry_id": entry_id,
        "_hint": (
            "Entry removed. The card is now eligible for re-claim by a "
            "runner via /next-assignment."
        ),
    }
    return json.dumps(result, indent=2, default=str)
