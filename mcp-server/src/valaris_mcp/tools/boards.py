# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp
from valaris_mcp.tools.definitions import build_definition_body

# A string enum rather than a bool: the wire value for "inherit" is null, and a
# bool parameter cannot express "clear the override" distinctly from "omitted".
_DONE_MERGE_GATE_VALUES = {"inherit": None, "enforced": True, "off": False}


@mcp.tool()
@handle_api_errors
async def list_boards(workspace_slug: str, ctx: Context) -> str:
    """List the boards in a workspace.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    boards = await client.get(f"{client.ws(workspace_slug)}/boards")
    result = {"total": len(boards), "boards": boards}
    if not boards:
        result["_hint"] = "No boards in this workspace. Use create_board to create one."
    return json.dumps(result, indent=2, default=str)


# The identity + triage fields a runner scans a board by. titles_only keeps
# only these per card and drops the heavy CardRead tail (description,
# participants, derived agent_presence / dependency counts) so a large board
# fits under the MCP token cap.
_CARD_TITLE_FIELDS = ("id", "column_id", "title", "status", "priority", "card_type", "labels")


@mcp.tool()
@handle_api_errors
async def get_board(
    workspace_slug: str,
    board_id: str,
    summary_only: bool = False,
    titles_only: bool = False,
    ctx: Context = None,
) -> str:
    """Get a board with its columns and their cards. On large boards pass summary_only or titles_only; summary_only wins when both are set.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        summary_only: Per-column card counts + priority/status breakdowns, no cards.
        titles_only: Slim each card to id/title/status/priority/labels.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(client.board(workspace_slug, board_id))
    columns = result.get("columns", [])
    if not columns:
        result["_hint"] = (
            "This board has no columns. Use create_column to add columns before creating cards."
        )
    else:
        for col in columns:
            col["_card_count"] = len(col.get("cards", []))
    if summary_only:
        for col in result.get("columns", []):
            cards = col.pop("cards", [])
            col["card_count"] = len(cards)
            if cards:
                col["priorities"] = {}
                col["statuses"] = {}
                for c in cards:
                    p = c.get("priority", "none")
                    s = c.get("status") or "unset"
                    col["priorities"][p] = col["priorities"].get(p, 0) + 1
                    col["statuses"][s] = col["statuses"].get(s, 0) + 1
    elif titles_only:
        for col in result.get("columns", []):
            col["cards"] = [
                {k: c[k] for k in _CARD_TITLE_FIELDS if k in c} for c in col.get("cards", [])
            ]
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_board(
    workspace_slug: str,
    name: str,
    slug: str | None = None,
    description: str = "",
    tags: list[str] | None = None,
    skip_default_columns: bool = False,
    scope: str | None = None,
    objectives: list[dict] | None = None,
    exclusions: list[str] | None = None,
    milestones: list[dict] | None = None,
    tech_stack: list[str] | None = None,
    stakeholders: list[dict] | None = None,
    constraints: list[str] | None = None,
    decisions: list[dict] | None = None,
    references: list[dict] | None = None,
    custom_fields: list[dict] | None = None,
    coding_standards: str | None = None,
    definition_content: dict | None = None,
    ctx: Context = None,
) -> str:
    """Create a board, optionally with its structured definition in the same call.

    Idempotent only when slug is given (an existing board with that slug is returned); without slug every call mints a new board. Definition fields upsert either way.

    Args:
        workspace_slug: Workspace slug.
        name: Display name.
        slug: URL slug; the idempotency key.
        description: Board purpose.
        tags: Tags.
        skip_default_columns: Skip the default typed columns (To Do/In Progress/Blocked/Done).
        scope: Definition scope/summary.
        objectives: [{"text", "priority"?}].
        exclusions: Out-of-scope items.
        milestones: [{"title", "date", "type"?}].
        tech_stack: ["python", "react", ...].
        stakeholders: [{"name", "role"?, "member_id"?, "channel_id"?}].
        constraints: Hard constraints.
        decisions: [{"decision", "rationale"?}].
        references: [{"url", "label"?}].
        custom_fields: [{"key", "value"?}].
        coding_standards: Free text.
        definition_content: Raw dict for other definition keys.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {"name": name, "description": description}
    if slug is not None:
        body["slug"] = slug
    if tags is not None:
        body["tags"] = tags
    if skip_default_columns:
        body["skip_default_columns"] = skip_default_columns
    result = await client.post(f"{client.ws(workspace_slug)}/boards", body)

    definition_body = build_definition_body(
        scope,
        definition_content,
        {
            "objectives": objectives,
            "exclusions": exclusions,
            "milestones": milestones,
            "tech_stack": tech_stack,
            "stakeholders": stakeholders,
            "constraints": constraints,
            "decisions": decisions,
            "references": references,
            "custom_fields": custom_fields,
            "coding_standards": coding_standards,
        },
    )
    if definition_body:
        board_id = result["id"]
        result["definition"] = await client.put(
            f"{client.board(workspace_slug, board_id)}/definitions", definition_body
        )

    hint = (
        "Board created without columns. Use create_column to add your own (e.g. Backlog, To Do, In Progress, Review, Done)."
        if skip_default_columns
        else "Board created with default typed columns (To Do, In Progress, Blocked, Done)."
    )
    result["_hint"] = hint
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_board(
    workspace_slug: str,
    board_id: str,
    name: str | None = None,
    description: str | None = None,
    tags: list[str] | None = None,
    done_merge_gate: str | None = None,
    ctx: Context = None,
) -> str:
    """Update a board's name, description, tags, or done-merge-gate override. Omitted fields are unchanged.

    Human keys only (runners get 403). done_merge_gate needs workspace admin/owner.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        name: New display name.
        description: New description.
        tags: Replaces the tag list.
        done_merge_gate: inherit|enforced|off. Gates RUNNER moves into done on a
            merged PR with an approving verdict (humans never gated; no linked
            repo = exempt); inherit follows the workspace flag.
    """
    if done_merge_gate is not None and done_merge_gate not in _DONE_MERGE_GATE_VALUES:
        return json.dumps(
            {
                "error": True,
                "message": (
                    f"update_board done_merge_gate must be one of "
                    f"{', '.join(_DONE_MERGE_GATE_VALUES)}; got "
                    f"'{done_merge_gate}'."
                ),
            },
            indent=2,
        )
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {"name": name, "description": description, "tags": tags}.items()
        if v is not None
    }
    if done_merge_gate is not None:
        # 'inherit' maps to an EXPLICIT null: the PATCH distinguishes omitted
        # (leave the override alone) from null (clear it back to inheriting),
        # so this key must be present in the body to clear anything.
        body["enforce_done_merge_gate"] = _DONE_MERGE_GATE_VALUES[done_merge_gate]
    result = await client.patch(client.board(workspace_slug, board_id), body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def freeze_board(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Freeze a board: every mutation returns 409 board_frozen and the scheduler stops handing out its cards until unfreeze_board.

    Reads and telemetry (execution logging, approvals) stay open. Workspace admin/owner. Idempotent.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"{client.board(workspace_slug, board_id)}/freeze")
    result["_hint"] = (
        "Board is frozen — all mutations now return 409 board_frozen and runners "
        "stop picking up its cards. Use unfreeze_board (workspace OWNER only) to reopen it."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def unfreeze_board(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Unfreeze a frozen board, reopening mutations and scheduling.

    Workspace owner only (admins can freeze but not unfreeze). Idempotent.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(f"{client.board(workspace_slug, board_id)}/unfreeze")
    result["_hint"] = "Board is open again — mutations and runner scheduling resume."
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def get_board_loop(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Read loop config: state, prompts, provider/model, tools, caps, disabled_reason, version and template (null for raw prompts). Unconfigured=404.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.board(workspace_slug, board_id)}/loop", headers={"X-Backplane-Completion-Version": "1"})
    result["_hint"] = (
        "Loop runs while enabled=true. Use set_board_loop to flip the state; "
        "disabled_reason records why it last stopped."
    )
    return json.dumps(result, indent=2, default=str)


def _template_binding(
    ref: str | None,
    source: str | None,
    version: int | None,
    slot_values: dict | None,
    detach: bool,
) -> dict | None:
    """The `template` object for PUT /loop, or None to leave the binding alone.

    Detach wins over a bind in the same call: the caller asked for the
    destructive lever explicitly, and silently binding what they asked to drop
    would be the worse surprise.
    """
    if detach:
        return {}
    if ref is None and slot_values is None:
        return None

    binding: dict[str, Any] = {}
    if ref is not None:
        binding["ref"] = ref
        binding["source"] = source or "system"
    if version is not None:
        binding["version"] = version
    if slot_values is not None:
        binding["slot_values"] = slot_values
    return binding


@mcp.tool()
@handle_api_errors
async def set_board_loop(
    workspace_slug: str,
    board_id: str,
    enabled: bool | None = None,
    reason: str = "",
    loop_prompt: str | None = None,
    system_prompt: str | None = None,
    provider: str | None = None,
    model: str | None = None,
    tools: list[str] | None = None,
    max_iterations: int | None = None,
    iteration_delay_seconds: int | None = None,
    iteration_timeout_seconds: int | None = None,
    budget_usd: float | None = None,
    max_consecutive_failures: int | None = None,
    max_blocked_on_human: int | None = None,
    starvation_policy: str | None = None,
    loop_landing: str | None = None,
    merge_gate: str | None = None,
    completion_query: dict | None = None,
    skills_proposal_enabled: bool | None = None,
    relax_done_merge_gate: bool | None = None,
    template_ref: str | None = None,
    template_source: str | None = None,
    template_version: int | None = None,
    slot_values: dict | None = None,
    detach_template: bool = False,
    expected_version: int | None = None,
    ctx: Context = None,
) -> str:
    """Edit loop config/state. Omitted fields persist; edits apply next iteration. Enable is idempotent, requiring nonempty loop_prompt. Config saves before state. When running in loop mode: call this with enabled=false and a concise reason when the objective is complete or you are blocked.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        enabled: True=start/resume, false=stop; omitted=config only.
        reason: Stop reason; saved only on enabled-to-disabled transition.
        loop_prompt: Iteration prompt.
        system_prompt: Session system prompt.
        provider: Coding agent (empty=runner default).
        model: Tier (premium/mid/low) or model ID.
        tools: Replacement mcp__valaris__* allowlist; []=full surface.
        max_iterations: Iterations/process (>=1).
        iteration_delay_seconds: Iteration cooldown (>=0).
        iteration_timeout_seconds: Session timeout (>=1).
        budget_usd: Cumulative budget since enable (>0).
        max_consecutive_failures: Failure breaker (>=1).
        max_blocked_on_human: Consecutive blocked_on_human stop threshold; 0=park only.
        starvation_policy: park (sleep when idle)|always_run.
        loop_landing: Legacy human|self_merge|merge_queue. Human self_merge saves auto-relax the Done merge gate.
        merge_gate: forge_ci (require green CI before queue merge)|none.
        completion_query: {label, exclude_column_type:"done"}; zero matches stops; {} clears.
        skills_proposal_enabled: Allow runner propose_skill; default true.
        relax_done_merge_gate: False declines self_merge auto-relax for this save.
        template_ref: System slug/workspace UUID to bind; owns prompts/tools (raw edits:422 alongside bind,409 later).
        template_source: system (default)|workspace.
        template_version: Published version; omitted=newest.
        slot_values: Full replacement {SLOT_NAME:value}; alone re-renders the binding.
        detach_template: Remove binding, retain rendered text; overrides template_ref.
        expected_version: Last-read loop version; stale=409.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    config_fields = {
        key: value
        for key, value in {
            "loop_prompt": loop_prompt,
            "system_prompt": system_prompt,
            "provider": provider,
            "model": model,
            "tools": tools,
            "max_iterations": max_iterations,
            "iteration_delay_seconds": iteration_delay_seconds,
            "iteration_timeout_seconds": iteration_timeout_seconds,
            "budget_usd": budget_usd,
            "max_consecutive_failures": max_consecutive_failures,
            "max_blocked_on_human": max_blocked_on_human,
            "starvation_policy": starvation_policy,
            "loop_landing": loop_landing,
            "merge_gate": merge_gate,
            "completion_query": completion_query,
            "skills_proposal_enabled": skills_proposal_enabled,
            "expected_version": expected_version,
        }.items()
        if value is not None
    }

    # The three-state convention completion_query already uses: {...} binds or
    # re-renders, {} detaches, absent leaves the binding alone. Assembled
    # explicitly because an empty dict is the DETACH lever — folding it through
    # the `is not None` filter above would drop the one shape that means
    # something by being empty.
    template = _template_binding(
        template_ref, template_source, template_version, slot_values, detach_template
    )
    if template is not None:
        config_fields["template"] = template

    # A bare optimistic lock is a precondition with nothing to apply: it would
    # PUT an empty merge and bump the version for nothing.
    if set(config_fields) == {"expected_version"}:
        config_fields.pop("expected_version")

    # Rides an existing config PUT only — a decline (false) is meaningful
    # solely on the save it declines, and alone it would be an empty merge.
    # Kept out of the comprehension above so it can never be the field that
    # turns a state-only call into a config PUT.
    if config_fields and relax_done_merge_gate is not None:
        config_fields["relax_done_merge_gate"] = relax_done_merge_gate

    if not config_fields and enabled is None:
        return json.dumps(
            {
                "error": "nothing to change — pass at least one config field "
                "or the enabled flag"
            },
            indent=2,
        )

    result = None
    if config_fields:
        result = await client.put(
            f"{client.board(workspace_slug, board_id)}/loop", config_fields
        )
    if enabled is not None:
        result = await client.patch(
            f"{client.board(workspace_slug, board_id)}/loop/state",
            {"enabled": enabled, "reason": reason},
        )

    if enabled is True:
        result["_hint"] = (
            "Loop is now running — the runner re-reads this config every iteration."
        )
    elif enabled is False:
        stored_reason = result.get("disabled_reason")
        if reason and stored_reason != reason:
            result["_hint"] = (
                "Loop is stopped; the requested reason was not stored. "
                "Same-state calls retain the previous disabled_reason; "
                "see the returned value."
            )
        elif stored_reason:
            result["_hint"] = "Loop is stopped; see the stored disabled_reason."
        else:
            result["_hint"] = "Loop is stopped; no disabled_reason is stored."
    else:
        result["_hint"] = (
            "Config saved; omitted fields kept their stored values. The "
            "runner picks this up on its next iteration."
        )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def delete_board(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Permanently delete a board and everything scoped to it. IRREVERSIBLE — confirm the board_id first.

    Cascades to columns, cards, notes, definition, git-repo bindings, resources; activity/execution history is kept but unlinked.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    await client.delete(client.board(workspace_slug, board_id))
    return (
        f"Board {board_id} deleted from workspace '{workspace_slug}'. "
        "This also removed its columns, cards, notes, definition, and git-repo "
        "bindings (irreversible)."
    )
