# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
import re

import httpx
from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _slugify(name: str) -> str:
    """Derive a URL-friendly slug from a workspace name."""
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug.strip("-")


@mcp.tool()
@handle_api_errors
async def list_workspaces(ctx: Context) -> str:
    """List workspaces the caller can access; use the slug for workspace-scoped tools.
    """
    app: AppContext = ctx.request_context.lifespan_context
    workspaces = await app.client.get("/workspaces")
    result = {"total": len(workspaces), "workspaces": workspaces}
    if not workspaces:
        result["_hint"] = "No workspaces found. Use create_workspace to create one."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_workspace(workspace_slug: str, ctx: Context) -> str:
    """Get a workspace's metadata (no member roster; see list_workspace_members).

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_workspace_members(
    workspace_slug: str,
    query: str | None = None,
    limit: int | None = None,
    ctx: Context = None,
) -> str:
    """List workspace members (user_id, email, name, role); resolves people to user_id before adding card participants.

    Args:
        workspace_slug: Workspace slug.
        query: Case-insensitive name/email search (capped autocomplete match).
        limit: Max members returned.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{client.ws(workspace_slug)}/members"
    params = []
    if query:
        params.append(f"q={query}")
    if limit is not None:
        params.append(f"limit={limit}")
    if params:
        path = f"{path}?{'&'.join(params)}"
    members = await client.get(path)
    result = {"total": len(members), "members": members}
    if not members:
        result["_hint"] = (
            "No members matched. Without a query this means the workspace is "
            "empty; with a query, try a shorter/partial name or email. Use "
            "add_workspace_member to add someone."
        )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def whoami(ctx: Context = None) -> str:
    """Identify the authenticated user behind this session (id, email, name).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get("/me")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_workspace_summary(workspace_slug: str, ctx: Context) -> str:
    """Get workspace aggregate stats: board/card/note/channel counts, recent activity, per-board board_stats (card_count, overdue_count, cards by column_type incl. untyped) and a 30-day activity_trend of {day, count} with zero-filled quiet days.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/summary")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_workspace(
    name: str,
    slug: str = "",
    ctx: Context = None,
) -> str:
    """Create a workspace; the creator becomes owner. If the slug already exists and you are a member, nothing is created: the existing workspace comes back under `existing` plus an `error` string (a no-op, not a failure). Non-members get a 409 with no metadata.

    Args:
        name: Display name.
        slug: URL slug; derived from name if omitted.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client

    slug = slug.strip() if slug else _slugify(name)

    # Check if workspace already exists
    try:
        existing = await client.get(f"{client.ws(slug)}")
        return json.dumps(
            {"error": f"Workspace with slug '{slug}' already exists", "existing": existing},
            indent=2,
            default=str,
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code not in (403, 404):
            raise

    result = await client.post("/workspaces", {"name": name, "slug": slug})
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def add_workspace_member(
    workspace_slug: str,
    user_email: str,
    role: str = "member",
    ctx: Context = None,
) -> str:
    """Add a user to a workspace, auto-provisioning them if needed. Idempotent: an existing member is returned unchanged and role is ignored; use update_workspace_member to change a role.

    Args:
        workspace_slug: Workspace slug.
        user_email: Email of the user to add.
        role: owner|admin|member|viewer (default member).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client

    result = await client.post(
        f"{client.ws(workspace_slug)}/members",
        {"email": user_email, "role": role},
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def remove_workspace_member(
    workspace_slug: str,
    user_id: str,
    ctx: Context = None,
) -> str:
    """Remove a member from a workspace.

    Args:
        workspace_slug: Workspace slug.
        user_id: User UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    await client.delete(f"{client.ws(workspace_slug)}/members/{user_id}")
    return f"Member {user_id} removed from workspace '{workspace_slug}'."


@mcp.tool()
@handle_api_errors
async def update_workspace_member(
    workspace_slug: str,
    user_id: str,
    role: str,
    ctx: Context = None,
) -> str:
    """Change a workspace member's role. Same role is a no-op; granting or demoting owner needs an acting owner and a human caller (runner keys get 403 human_required).

    Args:
        workspace_slug: Workspace slug.
        user_id: Member's user UUID.
        role: owner|admin|member|viewer.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.patch(
        f"{client.ws(workspace_slug)}/members/{user_id}", {"role": role}
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_workspace(workspace_slug: str, ctx: Context = None) -> str:
    """PERMANENTLY delete a workspace and everything in it (boards, columns, cards, definitions, git-repo bindings, notes, resources, channels, memberships). No undo; confirm the slug with list_workspaces first. Needs admin/owner; an already-deleted workspace reports so instead of erroring.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    try:
        await client.delete(client.ws(workspace_slug))
    except httpx.HTTPStatusError as e:
        # Idempotency: the second call of a retried delete must converge, not
        # error. Every other status still falls through to handle_api_errors.
        if e.response.status_code == 404:
            return (
                f"Workspace '{workspace_slug}' not found (or already deleted) "
                "— nothing to do."
            )
        raise
    return (
        f"Workspace '{workspace_slug}' deleted. This also removed its boards, "
        "cards, notes, resources, channels, and memberships (irreversible)."
    )
