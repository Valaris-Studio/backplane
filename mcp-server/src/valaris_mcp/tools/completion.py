# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import os
from typing import Any

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _base(client, workspace_slug, board_id):
    return f"{client.board(workspace_slug, board_id)}/completion"


@mcp.tool()
@handle_api_errors
async def get_completion_policy(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Read effective completion policy, inheritance and capabilities.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID/slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.client.get(f"{_base(app.client, workspace_slug, board_id)}/policy")
    result["_hint"] = (
        "Follow effective_policy; null preserves legacy behavior. An operator must resolve incompatibilities or change policy."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_completion_status(
    workspace_slug: str, board_id: str, card_id: str, ctx: Context = None
) -> str:
    """Read current candidate, exact source/merge SHAs and public attempt history.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID/slug.
        card_id: Card UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.client.get(f"{_base(app.client, workspace_slug, board_id)}/cards/{card_id}")
    result["_hint"] = (
        "Acceptance is bound to this candidate and its exact revisions. Use retry_completion for a failed resumable attempt."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def submit_completion_candidate(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    source_execution_id: str,
    source_sha: str | None = None,
    artifacts: list[dict[str, Any]] | None = None,
    checks: list[dict[str, Any]] | None = None,
    ctx: Context = None,
) -> str:
    """Submit execution provenance: a real open card PR, or exact evidence in operator-selected evidence-only mode.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID/slug.
        card_id: Card UUID.
        source_execution_id: This iteration's runner-supplied execution UUID.
        source_sha: Evidence source commit SHA (full).
        artifacts: Artifacts: [{name, uri, sha256}].
        checks: Checks: [{id, source_sha, exit_code, output}].
    """
    app: AppContext = ctx.request_context.lifespan_context
    execution_id = os.environ.get("BACKPLANE_SOURCE_EXECUTION_ID")
    if execution_id and source_execution_id != execution_id:
        return json.dumps(
            {
                "error": True,
                "message": "source_execution_id must match this runner launch execution",
            }
        )
    source_execution_id = execution_id or source_execution_id
    body = {
        key: value
        for key, value in {
            "source_execution_id": source_execution_id,
            "source_sha": source_sha,
            "artifacts": artifacts,
            "checks": checks,
        }.items()
        if value is not None
    }
    result = await app.client.post(
        f"{_base(app.client, workspace_slug, board_id)}/cards/{card_id}/submit", body
    )
    result["_hint"] = (
        "Submission does not bypass review or validation. Follow get_completion_status; request_landing is available only when policy permits."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def request_landing(
    workspace_slug: str, board_id: str, card_id: str, ctx: Context = None
) -> str:
    """Request current-candidate queue landing under server policy, review, provenance and forge gates.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID/slug.
        card_id: Card UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.client.post(
        f"{_base(app.client, workspace_slug, board_id)}/cards/{card_id}/land",
        {"method": "merge_queue"},
    )
    result["_hint"] = (
        "Inspect get_completion_status. Landing alone does not imply acceptance or Done; never work around a policy denial through another merge route."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def retry_completion(
    workspace_slug: str, board_id: str, card_id: str, ctx: Context = None
) -> str:
    """Retry a failed phase on the current immutable candidate. The runner produces review/validation results.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID/slug.
        card_id: Card UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await app.client.post(
        f"{_base(app.client, workspace_slug, board_id)}/cards/{card_id}/retry", {}
    )
    result["_hint"] = (
        "The platform schedules a fresh attempt. Check get_completion_status and resolve the reported failure before retrying again."
    )
    return json.dumps(result, indent=2, default=str)
