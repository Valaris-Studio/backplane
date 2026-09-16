# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def list_prompt_configs(
    workspace_slug: str,
    team_role: str | None = None,
    ctx: Context = None,
) -> str:
    """List prompt configs, optionally filtered by team role.

    Args:
        workspace_slug: Workspace slug.
        team_role: Filter, e.g. orchestrator|reviewer.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params = {}
    if team_role is not None:
        params["team_role"] = team_role
    result = await client.get(
        f"/workspaces/{workspace_slug}/prompt-configs", **params
    )
    if isinstance(result, list):
        wrapped = {"items": result, "total": len(result)}
    else:
        wrapped = result
    wrapped["_hint"] = (
        "Use create_prompt_config to add overrides, "
        "or get prompt defaults with GET /defaults."
    )
    return json.dumps(wrapped, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_prompt_config(
    workspace_slug: str,
    config_id: str,
    ctx: Context = None,
) -> str:
    """Get one prompt config.

    Args:
        workspace_slug: Workspace slug.
        config_id: Prompt config UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(
        f"/workspaces/{workspace_slug}/prompt-configs/{config_id}"
    )
    result["_hint"] = "Use update_prompt_config to modify or delete_prompt_config to remove."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_prompt_config(
    workspace_slug: str,
    name: str,
    slug: str,
    stage: str,
    content: str,
    agent_type: str | None = None,
    team_role: str | None = None,
    team_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Create a prompt config: a stage prompt override for matching runners,
    applied on their next config refresh.

    Args:
        workspace_slug: Workspace slug.
        name: Display name.
        slug: Unique slug.
        stage: e.g. implement|review|plan.
        content: Prompt template text.
        agent_type: coding|manager|reviewer|secretary|improver.
        team_role: e.g. orchestrator|reviewer.
        team_id: Team UUID scope.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "slug": slug,
            "stage": stage,
            "content": content,
            "agent_type": agent_type,
            "team_role": team_role,
            "team_id": team_id,
        }.items()
        if v is not None
    }
    result = await client.post(
        f"/workspaces/{workspace_slug}/prompt-configs", body
    )
    result["_hint"] = (
        "Prompt config created. It will apply to runners matching "
        "the team_role/agent_type on next config refresh."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_prompt_config(
    workspace_slug: str,
    config_id: str,
    name: str | None = None,
    slug: str | None = None,
    stage: str | None = None,
    content: str | None = None,
    agent_type: str | None = None,
    team_role: str | None = None,
    team_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Update a prompt config; omitted fields are unchanged.

    Args:
        workspace_slug: Workspace slug.
        config_id: Prompt config UUID.
        name: New name.
        slug: New slug.
        stage: New stage.
        content: New prompt text.
        agent_type: coding|manager|reviewer|secretary|improver.
        team_role: New team role filter.
        team_id: New team UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "slug": slug,
            "stage": stage,
            "content": content,
            "agent_type": agent_type,
            "team_role": team_role,
            "team_id": team_id,
        }.items()
        if v is not None
    }
    result = await client.patch(
        f"/workspaces/{workspace_slug}/prompt-configs/{config_id}", body
    )
    result["_hint"] = "Prompt config updated. Changes apply on next runner config refresh."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_prompt_config(
    workspace_slug: str,
    config_id: str,
    ctx: Context = None,
) -> str:
    """Delete a prompt config; affected runners fall back to defaults.

    Args:
        workspace_slug: Workspace slug.
        config_id: Prompt config UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    await client.delete(
        f"/workspaces/{workspace_slug}/prompt-configs/{config_id}"
    )
    return json.dumps(
        {
            "deleted": True,
            "config_id": config_id,
            "_hint": "Prompt config deleted. Runners using this config will fall back to defaults.",
        },
        indent=2,
        default=str,
    )
