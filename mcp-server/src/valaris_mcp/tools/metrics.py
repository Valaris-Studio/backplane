# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp

METRICS_VIEWS = ("all", "velocity", "cost")


async def _velocity_and_quality(client, workspace_slug: str) -> dict:
    velocity = await client.get(f"{client.ws(workspace_slug)}/metrics/velocity")
    quality = await client.get(f"{client.ws(workspace_slug)}/metrics/quality")
    return {"velocity": velocity, "quality": quality}


async def _cost(client, workspace_slug: str) -> dict:
    agent_costs = await client.get(f"{client.ws(workspace_slug)}/metrics/cost")
    card_costs = await client.get(f"{client.ws(workspace_slug)}/metrics/card-costs")
    return {"agents": agent_costs.get("agents", []), "cards": card_costs.get("cards", [])}


@mcp.tool()
@handle_api_errors
async def get_workspace_metrics(workspace_slug: str, view: str = "all", ctx: Context = None) -> str:
    """Workspace-wide delivery and spend figures in one read. velocity: cards completed over 7d/30d/90d; quality: reversion_rate (done cards that came back) and agent_efficiency_score — falling velocity with rising reversion means rework, not slowdown. cost: per-runner tokens/executions over 7d/30d and per-card total_cost_usd/tokens/execution_count — a card whose execution_count keeps climbing outside done is a money-loop. Do not re-derive totals. Per-board velocity is get_board_health; per-runner spend is get_agent_budget_status.

    Args:
        workspace_slug: Workspace slug.
        view: "all" (default), "velocity" (velocity + quality only) or "cost" (spend only).
    """
    if view not in METRICS_VIEWS:
        return json.dumps(
            {"error": True, "message": f"view must be one of {', '.join(METRICS_VIEWS)}; got {view!r}"},
            indent=2,
        )
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result: dict = {}
    if view in ("all", "velocity"):
        result.update(await _velocity_and_quality(client, workspace_slug))
    if view in ("all", "cost"):
        result["cost"] = await _cost(client, workspace_slug)
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def get_workspace_cost(workspace_slug: str, ctx: Context = None) -> str:
    """Runner token spend and per-card cost for a workspace.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    return json.dumps(await _cost(app.client, workspace_slug), indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def get_workspace_velocity(workspace_slug: str, ctx: Context = None) -> str:
    """Workspace throughput and quality figures.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    return json.dumps(await _velocity_and_quality(app.client, workspace_slug), indent=2, default=str)
