# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def log_execution_start(
    workspace_slug: str,
    agent_id: str,
    action: str,
    input_summary: str,
    board_id: str | None = None,
    card_id: str | None = None,
    session_id: str | None = None,
    parent_execution_id: str | None = None,
    role: str | None = None,
    input_prompt: str | None = None,
    ctx: Context = None,
) -> str:
    """Log the start of a runner execution; returns execution_id for log_execution_update.

    Args:
        workspace_slug: Workspace slug.
        agent_id: Runner UUID.
        action: Short action name, e.g. 'review_pr'.
        input_summary: What the runner was asked to do.
        board_id: Board UUID if board-scoped.
        card_id: Card UUID if card-scoped; marks it actively worked.
        session_id: Coding-agent session id.
        parent_execution_id: Execution UUID this retries.
        role: Pipeline role, e.g. 'implementer'.
        input_prompt: Full rendered prompt.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {
        "workspace_slug": workspace_slug,
        "action": action,
        "input_summary": input_summary,
    }
    if board_id is not None:
        body["board_id"] = board_id
    if card_id is not None:
        body["card_id"] = card_id
    if session_id is not None:
        body["session_id"] = session_id
    if parent_execution_id is not None:
        body["parent_execution_id"] = parent_execution_id
    if role is not None:
        body["role"] = role
    if input_prompt is not None:
        body["input_prompt"] = input_prompt
    result = await client.post(f"/agents/{agent_id}/executions", body)
    result["_hint"] = (
        f"Execution {result.get('id')} started. "
        "Call log_execution_update with this execution_id when the workflow completes or fails."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def log_execution_update(
    agent_id: str,
    execution_id: str,
    status: str,
    output_summary: str | None = None,
    tools_used: list[str] | None = None,
    cards_affected: list[str] | None = None,
    error_message: str | None = None,
    tool_calls_count: int | None = None,
    tokens_used: int | None = None,
    cost_usd: float | None = None,
    input_prompt: str | None = None,
    duration_seconds: float | None = None,
    ship_warnings: list[str] | None = None,
    ctx: Context = None,
) -> str:
    """Record an execution's status, result, or error at completion, failure, or a checkpoint.

    Args:
        agent_id: Runner UUID.
        execution_id: From log_execution_start.
        status: completed|failed|running.
        output_summary: What was accomplished.
        tools_used: MCP tool names invoked.
        cards_affected: Card UUIDs touched.
        error_message: Details when failed.
        tool_calls_count: Total tool calls.
        tokens_used: Input + output tokens.
        cost_usd: Cost in USD.
        input_prompt: Full rendered prompt.
        duration_seconds: Wall-clock seconds.
        ship_warnings: Non-fatal stage issues (amber chips); status stays as given.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "status": status,
            "output_summary": output_summary,
            "tools_used": tools_used,
            "cards_affected": cards_affected,
            "error_message": error_message,
            "tool_calls_count": tool_calls_count,
            "tokens_used": tokens_used,
            "cost_usd": cost_usd,
            "input_prompt": input_prompt,
            "duration_seconds": duration_seconds,
            "ship_warnings": ship_warnings,
        }.items()
        if v is not None
    }
    result = await client.patch(f"/agents/{agent_id}/executions/{execution_id}", body)
    result["_hint"] = f"Execution {execution_id} updated to '{status}'."
    return json.dumps(result, indent=2, default=str)


_TERMINAL_STATUSES = ("completed", "failed", "aborted")


@mcp.tool()
@handle_api_errors
async def cancel_execution(
    agent_id: str,
    execution_id: str,
    status: str = "aborted",
    reason: str = "",
    ctx: Context = None,
) -> str:
    """Force a stuck 'running' execution to a terminal status, clearing the
    agent_busy 409 guard that stalls the pipeline.

    Args:
        agent_id: Runner UUID.
        execution_id: Execution UUID (list_executions status='inflight' finds zombies).
        status: aborted (default)|completed|failed; non-terminal values are rejected.
        reason: Recorded as output_summary.
    """
    if status not in _TERMINAL_STATUSES:
        return json.dumps(
            {
                "error": True,
                "message": (
                    f"cancel_execution status must be terminal (one of "
                    f"{', '.join(_TERMINAL_STATUSES)}); got '{status}'. A "
                    "non-terminal status would not clear the agent_busy guard."
                ),
            },
            indent=2,
        )
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {"status": status}
    if reason:
        body["output_summary"] = reason
    result = await client.patch(f"/agents/{agent_id}/executions/{execution_id}", body)
    result["_hint"] = (
        f"Execution {execution_id} forced to '{status}'. The busy-guard is "
        "cleared; the runner can reserve work again on its next poll."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_executions(
    workspace_slug: str,
    agent_id: str | None = None,
    status: str | None = None,
    role: str | None = None,
    card_id: str | None = None,
    limit: int = 20,
    ctx: Context = None,
) -> str:
    """List runner execution history for a workspace, newest first. Rows are
    heavy (full input_prompt); keep limit small. Before cancel_execution on a
    row, verify its agent_id/card_id match the scope you meant.

    Args:
        workspace_slug: Workspace slug.
        agent_id: Only this runner.
        status: started|running|completed|failed|aborted|skipped, or 'inflight' =
            all active rows workspace-wide, ignoring limit.
        role: Pipeline role.
        card_id: That card's history, ignoring limit, capped at the newest 200 rows.
        limit: Default 20, caps at 200.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    # Backend validates limit with le=200 (422, not a cap) — clamp so the
    # documented "caps at 200" holds for retry-happy runner callers.
    params: dict = {"limit": min(limit, 200)}
    if agent_id is not None:
        params["agent_id"] = agent_id
    if status is not None:
        params["status"] = status
    if role is not None:
        params["role"] = role
    if card_id is not None:
        params["card_id"] = card_id
    result = await client.get(f"{client.ws(workspace_slug)}/executions", **params)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_agent_config(ctx: Context = None) -> str:
    """Get the runner identity linked to this API key (agent_id, allowed_workspaces,
    allowed_actions); falls back to the user identity when no runner is linked.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    try:
        result = await client.get("/agents/me")
        result["_hint"] = (
            "This is your runner identity. Your agent_id, allowed_workspaces, "
            "and allowed_actions define your constraints. Use agent_id with "
            "log_execution_start to create execution audit trails."
        )
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            result = await client.get("/me")
            result["_hint"] = (
                "No runner linked to this API key. Using user identity only. "
                "Runner features (execution tracking, approvals) require a linked runner."
            )
        else:
            raise
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_agent(
    name: str,
    agent_type: str,
    allowed_workspaces: list[str],
    description: str = "",
    allowed_actions: list[str] | None = None,
    max_requests_per_minute: int = 100,
    budget_usd: float | None = None,
    ctx: Context = None,
) -> str:
    """Create a runner identity; raw_api_key is returned exactly once.

    Args:
        name: Display name.
        agent_type: coding|manager|reviewer|secretary|improver.
        allowed_workspaces: Workspace slugs the runner may see; must be non-empty.
        description: What it does.
        allowed_actions: Action allowlist (None = all).
        max_requests_per_minute: Rate limit.
        budget_usd: Spending cap in USD.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "agent_type": agent_type,
            "description": description,
            "allowed_workspaces": allowed_workspaces,
            "allowed_actions": allowed_actions,
            "max_requests_per_minute": max_requests_per_minute,
            "budget_usd": budget_usd,
        }.items()
        if v is not None
    }
    result = await client.post("/agents", body)
    result["_hint"] = (
        "Runner created. Save the raw_api_key — it won't be shown again. "
        "Use add_team_member to assign roles."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_agent(
    agent_id: str,
    name: str | None = None,
    description: str | None = None,
    allowed_workspaces: list[str] | None = None,
    allowed_actions: list[str] | None = None,
    max_requests_per_minute: int | None = None,
    budget_usd: float | None = None,
    is_active: bool | None = None,
    hard_delete: bool = False,
    ctx: Context = None,
) -> str:
    """Update a runner's profile or constraints; only passed fields change. is_active=false is the reversible retirement; hard_delete=true erases the runner instead (API key, executions, approvals, team memberships — unrecoverable; 409 while a card is in flight) and accepts no other field.

    Args:
        agent_id: Runner UUID.
        name: New display name.
        description: New description.
        allowed_workspaces: Replacement allowlist; non-empty.
        allowed_actions: New action allowlist.
        max_requests_per_minute: New rate limit.
        budget_usd: New spending cap.
        is_active: False disables (reversible).
        hard_delete: True permanently erases the runner (unrecoverable); alone, with no other field.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "name": name,
            "description": description,
            "allowed_workspaces": allowed_workspaces,
            "allowed_actions": allowed_actions,
            "max_requests_per_minute": max_requests_per_minute,
            "budget_usd": budget_usd,
            "is_active": is_active,
        }.items()
        if v is not None
    }
    if hard_delete:
        if body:
            return json.dumps(
                {
                    "error": True,
                    "message": "hard_delete=True erases the runner and accepts no other field; "
                    f"drop {sorted(body)} or use is_active=false for a reversible disable",
                },
                indent=2,
            )
        return json.dumps(await _hard_delete_agent(client, agent_id), indent=2, default=str)
    result = await client.patch(f"/agents/{agent_id}", body)
    result["_hint"] = "Runner updated. Changes take effect on next config refresh (heartbeat cycle)."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_agent(
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Get one runner's profile.

    Args:
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"/agents/{agent_id}")
    result["_hint"] = "Runner details retrieved. Use update_agent to modify, add_team_member to assign roles."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_agents(
    include_inactive: bool = False,
    ctx: Context = None,
) -> str:
    """List the runners this user can administer.

    Args:
        include_inactive: Also return deactivated runners.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    agents = await client.get("/agents", include_inactive=include_inactive)
    return json.dumps(
        {
            "agents": agents,
            "_hint": (
                "Use pause_agent to stop a runner from taking new cards, "
                "get_agent_budget_status to check spend, rotate_agent_key to replace a leaked key."
            ),
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def pause_agent(
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Stop a runner from picking up new cards (idempotent); its in-flight card
    still finishes, so use cancel_execution to end that too.

    Args:
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"/agents/{agent_id}/pause")
    result["_hint"] = "Runner paused — no new card pickups. Use resume_agent to re-enable."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def resume_agent(
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Re-enable card pickup for a paused runner (idempotent).

    Args:
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"/agents/{agent_id}/resume")
    result["_hint"] = "Runner resumed — it will pick up cards on its next poll."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def restart_agent(
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Ask a live runner to finish its in-flight card and exit for its supervisor
    to relaunch on fresh config; an offline runner returns 503.

    Args:
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"/agents/{agent_id}/restart")
    result["_hint"] = (
        "Restart requested — the runner finishes its current card, then exits. "
        "Confirm it came back with list_agents (health_started_at moves)."
    )
    return json.dumps(result, indent=2, default=str)


async def _hard_delete_agent(client, agent_id: str) -> dict:
    await client.delete(f"/agents/{agent_id}/hard")
    return {
        "deleted": True,
        "agent_id": agent_id,
        "_hint": "Runner erased: its API key, executions, approvals and team memberships are gone.",
    }


@deprecated_tool()
@handle_api_errors
async def hard_delete_agent(agent_id: str, confirm: bool = False, ctx: Context = None) -> str:
    """Permanently delete a runner (unrecoverable); 409 while a card is in flight.

    Args:
        agent_id: Runner UUID.
        confirm: Must be True.
    """
    if not confirm:
        return json.dumps(
            {
                "deleted": False,
                "agent_id": agent_id,
                "_hint": "Refused: unrecoverable. Re-call with confirm=True if certain, or "
                "update_agent(is_active=False) for a reversible disable.",
            },
            indent=2,
            default=str,
        )
    app: AppContext = ctx.request_context.lifespan_context
    return json.dumps(await _hard_delete_agent(app.client, agent_id), indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_agent_budget_status(
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Check one runner's spend against its budget cap.

    Args:
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"/agents/{agent_id}/budget-status")
    result["_hint"] = (
        "Raise the cap with update_agent(budget_usd=...) or contain the runner with pause_agent."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def rotate_agent_key(
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Mint a new API key for a runner; the old key dies immediately and
    raw_api_key appears only in this result.

    Args:
        agent_id: Runner UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"/agents/{agent_id}/rotate-key")
    result["_hint"] = (
        "Old key is dead. Save raw_api_key now — it is not retrievable again."
    )
    return json.dumps(result, indent=2, default=str)
