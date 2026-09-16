# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace config & pipeline tools.

Thin pass-throughs to the workspace-config and sensor-catalog endpoints.
The backend is authoritative — this module never validates or canonicalizes
payloads. Errors (including 422 from the pipeline-config validator) bubble
up via `handle_api_errors` as structured JSON.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


@mcp.tool()
@handle_api_errors
async def get_workspace_config(workspace_slug: str, ctx: Context = None) -> str:
    """Read the workspace config: pipeline_config, max_rework_attempts, card_cooldown_hours, commit/PR templates, model_pricing, cost_circuit_breaker, role_labels, version (bumps on every update).

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/config")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_workspace_config(
    workspace_slug: str,
    max_rework_attempts: int | None = None,
    card_cooldown_hours: float | None = None,
    commit_message_template: str | None = None,
    pr_description_template: str | None = None,
    model_pricing: dict | None = None,
    pipeline_config: dict | None = None,
    cost_circuit_breaker: dict | None = None,
    role_labels: dict | None = None,
    expected_version: int | None = None,
    ctx: Context = None,
) -> str:
    """PATCH the workspace config; omitted fields stay unchanged. Requires admin/owner.

    Not pre-validated: a malformed payload returns the backend validator's 422 error list as message. Pass {} to clear a dict field. Stage edits: read with get_workspace_config, mutate, send back the whole pipeline_config.

    Args:
        workspace_slug: Workspace slug.
        max_rework_attempts: Per-card rework cap.
        card_cooldown_hours: Wait before re-offering a released card.
        commit_message_template: Runner commit message template.
        pr_description_template: PR description template.
        model_pricing: Per-model $/token overrides, merged over defaults.
        pipeline_config: {"stages": [{role, discover, claim, git, llm, on_success}],
            "scheduling"?}; llm.context_sources[] = {"kind", "filter"?, "as"?} with
            kind card_notes|board_definition|pinned_notes|sibling_cards|board_snapshot|review_history.
        cost_circuit_breaker: {enabled, threshold_usd_per_15min, action: alert|pause|kill_runner}.
        role_labels: Per-role display labels, e.g. {"implementer": "Coder"}.
        expected_version: 409 when the stored version differs.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client

    body: dict[str, Any] = {
        k: v
        for k, v in {
            "max_rework_attempts": max_rework_attempts,
            "card_cooldown_hours": card_cooldown_hours,
            "commit_message_template": commit_message_template,
            "pr_description_template": pr_description_template,
            "model_pricing": model_pricing,
            "pipeline_config": pipeline_config,
            "cost_circuit_breaker": cost_circuit_breaker,
            "role_labels": role_labels,
            "expected_version": expected_version,
        }.items()
        if v is not None
    }

    if not body:
        return json.dumps(
            {
                "error": True,
                "message": (
                    "update_workspace_config called with no fields. Pass at least "
                    "one of pipeline_config, max_rework_attempts, card_cooldown_hours, "
                    "commit_message_template, pr_description_template, model_pricing, "
                    "cost_circuit_breaker, role_labels."
                ),
            },
            indent=2,
        )

    result = await client.patch(f"{client.ws(workspace_slug)}/config", body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def export_pipeline_bundle(workspace_slug: str, ctx: Context = None) -> str:
    """Export a portable bundle (pipeline_config, derived setup_contract, workspace-scoped prompt_configs) for import_pipeline_bundle on another workspace. Platform-default prompts are excluded; they re-seed on the target.

    Args:
        workspace_slug: Source workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/config/bundle/export")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def import_pipeline_bundle(
    workspace_slug: str,
    bundle: dict,
    dry_run: bool = True,
    ctx: Context = None,
) -> str:
    """Import a pipeline bundle into a workspace. DRY-RUN BY DEFAULT: inspect the preview, then re-call with dry_run=false. Requires admin/owner.

    Checks: envelope (400), pipeline validation (422), expected_pipeline_version vs the target (409). Apply is atomic; re-import is idempotent.

    Args:
        workspace_slug: Target workspace slug.
        bundle: The envelope from export_pipeline_bundle.
        dry_run: Preview only (default). false applies.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    flag = "true" if dry_run else "false"
    result = await client.post(
        f"{client.ws(workspace_slug)}/config/bundle/import?dry_run={flag}",
        bundle,
    )
    if isinstance(result, dict):
        result.setdefault(
            "_hint",
            "Dry-run preview — re-call with dry_run=false to apply."
            if dry_run
            else "Bundle applied. Verify with get_workspace_config.",
        )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_pipeline_sensors(workspace_slug: str, ctx: Context = None) -> str:
    """List the sensors runners in this workspace have registered — what pipeline_config.stages[*].sensors[*].name is validated against. Deduped union; the first runner to report a name wins.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/sensors")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def resume_cost_breaker(workspace_slug: str, ctx: Context = None) -> str:
    """Clear a tripped cost circuit breaker so runners can pick up work again — use when next_assignment returns 423 for every runner.

    An acknowledgement, not a mute: the next spend over the threshold re-trips it. Threshold/action are unchanged (update_workspace_config). Admin/owner only. Returns {status: "resumed", workspace_id}.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"{client.ws(workspace_slug)}/cost-breaker/resume")
    result["_hint"] = (
        "Cost breaker cleared. Runners resume on their next next_assignment poll; "
        "the breaker re-trips if spend crosses the threshold again."
    )
    return json.dumps(result, indent=2, default=str)
