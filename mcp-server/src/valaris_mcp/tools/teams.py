# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def list_teams(
    workspace_slug: str,
    include_inactive: bool = False,
    ctx: Context = None,
) -> str:
    """List a workspace's teams with members and board assignments.

    Args:
        workspace_slug: Workspace slug.
        include_inactive: Include inactive teams.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(
        f"/workspaces/{workspace_slug}/teams",
        include_inactive=str(include_inactive).lower(),
    )
    for team in result if isinstance(result, list) else []:
        team["_hint"] = "Use get_board to see which board a team is scoped to."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_team(
    workspace_slug: str,
    team_id: str,
    ctx: Context = None,
) -> str:
    """Get one team with its members and their roles.

    Args:
        workspace_slug: Workspace slug.
        team_id: Team UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(
        f"/workspaces/{workspace_slug}/teams/{team_id}"
    )
    result["_hint"] = (
        "Team includes members with roles. "
        "Use this to understand team composition."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_team(
    workspace_slug: str,
    name: str,
    description: str = "",
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Create a team of runners in a workspace.

    Args:
        workspace_slug: Workspace slug.
        name: Team name.
        description: What it does.
        board_id: Board UUID to scope the team to.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {"name": name, "description": description}
    if board_id is not None:
        body["board_id"] = board_id
    result = await client.post(f"/workspaces/{workspace_slug}/teams", body)
    result["_hint"] = "Team created. Use add_team_member to assign runners with roles."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_team(
    workspace_slug: str,
    team_id: str,
    name: str | None = None,
    description: str | None = None,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Update a team; only passed fields change.

    Args:
        workspace_slug: Workspace slug.
        team_id: Team UUID.
        name: New name.
        description: New description.
        board_id: New board scope.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {k: v for k, v in {"name": name, "description": description, "board_id": board_id}.items() if v is not None}
    result = await client.patch(f"/workspaces/{workspace_slug}/teams/{team_id}", body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def deactivate_team(
    workspace_slug: str,
    team_id: str,
    ctx: Context = None,
) -> str:
    """Deactivate (soft-delete) a team.

    Args:
        workspace_slug: Workspace slug.
        team_id: Team UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.delete(f"/workspaces/{workspace_slug}/teams/{team_id}")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def add_team_member(
    workspace_slug: str,
    team_id: str,
    agent_id: str,
    roles: list[str] | None = None,
    role: str | None = None,
    ctx: Context = None,
) -> str:
    """Add a runner to a team with roles; idempotent, re-adding updates the roles.
    orchestrator/reviewer/documentator are one runner per team; custom allows many.

    Args:
        workspace_slug: Workspace slug.
        team_id: Team UUID.
        agent_id: Runner UUID.
        roles: One or more of orchestrator|reviewer|documentator|custom.
        role: Single role (legacy; prefer roles).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_roles = roles or ([role] if role else ["custom"])
    body = {"agent_id": agent_id, "roles": resolved_roles}
    result = await client.post(f"/workspaces/{workspace_slug}/teams/{team_id}/members", body)
    result["_hint"] = f"Runner {agent_id} added to team with roles {resolved_roles}."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def remove_team_member(
    workspace_slug: str,
    team_id: str,
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Remove a runner from a team.

    Args:
        workspace_slug: Workspace slug.
        team_id: Team UUID.
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.delete(f"/workspaces/{workspace_slug}/teams/{team_id}/members/{agent_id}")
    return json.dumps(result, indent=2, default=str)
