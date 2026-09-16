# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop template catalog & manager tools — the MCP twin of /loop-templates.

Two-layer rule: every operator capability exists on the platform UI AND here.
These are thin pass-throughs; the backend owns validation, the optimistic
locks, and the admin + runner-caller gating. A 403 on a mutation is the backend
refusing a runner key, and it is relayed verbatim — a runner editing the prompt
that governs it is the one privilege escalation this surface must not permit.

`ref` is a system slug (e.g. "coding-loop") OR a workspace template's row UUID.
The two namespaces never mix, so one parameter addresses both; there is no
`slug@version` ref form (that string is the EXECUTION stamp format, not a ref).

Loops and pipelines are different runner features: every name here carries the
`loop_template` qualifier so a generic `list_templates` can never appear.
"""

from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _templates(client, workspace_slug: str) -> str:
    return f"{client.ws(workspace_slug)}/loop-templates"


# The preview fields that carry rendered prompt bodies — the whole reason
# include_prompts=False exists, since these three dwarf everything else.
_PREVIEW_PROMPT_FIELDS = frozenset(
    {"system_prompt", "loop_prompt", "loop_prompt_with_tools_manifest"}
)


@mcp.tool()
@handle_api_errors
async def list_loop_templates(
    workspace_slug: str,
    q: str | None = None,
    sort: str = "name",
    include_archived: bool = False,
    ctx: Context = None,
) -> str:
    """List loop templates: system first, then workspace. Summaries only;
    get_loop_template carries the prompts, slots and tool grants. meta.runner_vars
    is the runner's Go-template variable vocabulary (never hardcode it).

    Args:
        workspace_slug: Workspace slug.
        q: Free-text filter over name and slug.
        sort: name|updated_at|boards_using.
        include_archived: Also list archived workspace templates.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params: dict[str, Any] = {"sort": sort, "include_archived": include_archived}
    if q is not None:
        params["q"] = q
    result = await client.get(_templates(client, workspace_slug), **params)
    return json.dumps(result, indent=2, default=str)


LOOP_TEMPLATE_VIEWS = ("full", "profile", "preview", "fit", "lint")
_PREVIEW_ONLY = ("slot_values",)


def _view_error(message: str) -> str:
    return json.dumps({"error": True, "message": message}, indent=2)


async def _template_full(client, workspace_slug, ref, draft, include_archived) -> dict:
    return await client.get(
        f"{_templates(client, workspace_slug)}/{ref}",
        draft=draft,
        include_archived=include_archived,
    )


async def _template_profile(client, workspace_slug, ref) -> dict:
    return await client.get(f"{_templates(client, workspace_slug)}/{ref}/profile")


async def _template_preview(client, workspace_slug, ref, slot_values, board_id, include_prompts, *, loop_config=None, draft=None, version=None) -> dict:
    base = client.board(workspace_slug, board_id) if board_id is not None else client.ws(workspace_slug)
    body = {"slot_values": slot_values or {}}
    body.update({k: v for k, v in {"loop_config": loop_config, "draft": draft, "version": version}.items() if v is not None})
    result = await client.post(f"{base}/loop-templates/{ref}/preview", body)
    if not include_prompts:
        result = {k: v for k, v in result.items() if k not in _PREVIEW_PROMPT_FIELDS}
        result["_hint"] = (
            "Prompt bodies omitted (include_prompts=False). Re-run with "
            "include_prompts=True to read the rendered prompts."
        )
    return result


async def _template_fit(client, workspace_slug, board_id, ref, *, slot_values=None, loop_config=None, draft=None, version=None) -> dict:
    path = f"{client.board(workspace_slug, board_id)}/loop-templates/{ref}/fit"
    if slot_values is None and loop_config is None and draft is None and version is None:
        result = await client.get(path)
    else:
        body = {"slot_values": slot_values or {}}
        body.update({k: v for k, v in {"loop_config": loop_config, "draft": draft, "version": version}.items() if v is not None})
        result = await client.post(path, body)
    fixable = [c.get("fix_id") for c in result.get("checks", []) if c.get("fix_id")]
    result["_hint"] = (
        f"{len(fixable)} check(s) carry a fix_id — pass them to "
        "apply_loop_template_fixes to close the gaps, then re-check."
        if fixable
        else "Nothing here is auto-fixable; remaining gaps need a human decision."
    )
    return result


async def _template_lint(client, workspace_slug, ref) -> dict:
    return await client.post(f"{client.ws(workspace_slug)}/loop-templates/{ref}/lint", {})


@mcp.tool()
@handle_api_errors
async def get_loop_template(
    workspace_slug: str,
    ref: str,
    view: str = "full",
    draft: bool | None = None,
    include_archived: bool = False,
    board_id: str | None = None,
    slot_values: dict[str, Any] | None = None,
    include_prompts: bool = True,
    loop_config: dict[str, Any] | None = None,
    version: int | None = None,
    ctx: Context = None,
) -> str:
    """Read a template: full=profile/prompts/slots/rails/tools; profile=identity and board/execution/spend/outcome history (archived included); preview=read-only render with board autofill/rails; fit=board checks (ok|missing|warn), evidence, fix_id for apply_loop_template_fixes, and autofill; lint=repo facts to move into slots (hints only, draft). Rehearse published text before binding. Avoid full prompt previews inside running loops.

    Args:
        workspace_slug: Workspace slug.
        ref: System slug or template UUID.
        view: full (default)|profile|preview|fit|lint.
        draft: True=draft, false=published. Default: false for full, true for rehearsal.
        include_archived: full: also resolve archived templates.
        board_id: Board UUID/slug; required for fit, optional for preview.
        slot_values: fit/preview: proposed slots; missing values use autofill, then defaults.
        include_prompts: preview: false omits large prompt bodies, keeping findings/slots/rails/tools.
        loop_config: fit/preview: unsaved loop rails.
        version: fit/preview: exact published version; requires draft=false.
    """
    if view not in LOOP_TEMPLATE_VIEWS:
        return _view_error(f"view must be one of {', '.join(LOOP_TEMPLATE_VIEWS)}; got {view!r}")
    if view == "fit" and not board_id:
        return _view_error('view="fit" needs board_id')
    if board_id is not None and view not in ("fit", "preview"):
        return _view_error('board_id only applies to view="fit" or view="preview"')
    if any(value is not None for value in (slot_values, loop_config, version)) and view not in ("fit", "preview"):
        return _view_error('slot_values, loop_config and version only apply to view="fit" or view="preview"')

    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    if view == "full":
        result = await _template_full(client, workspace_slug, ref, bool(draft), include_archived)
    elif view == "profile":
        result = await _template_profile(client, workspace_slug, ref)
    elif view == "preview":
        result = await _template_preview(client, workspace_slug, ref, slot_values, board_id, include_prompts, loop_config=loop_config, draft=draft, version=version)
    elif view == "fit":
        result = await _template_fit(client, workspace_slug, board_id, ref, slot_values=slot_values, loop_config=loop_config, draft=draft, version=version)
    else:
        result = await _template_lint(client, workspace_slug, ref)
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def get_loop_template_profile(workspace_slug: str, ref: str, ctx: Context = None) -> str:
    """Read a template's identity plus track record.

    Args:
        workspace_slug: Workspace slug.
        ref: System slug or template UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _template_profile(app.client, workspace_slug, ref)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_loop_template(
    workspace_slug: str,
    slug: str,
    name: str,
    content: dict | None = None,
    profile: dict | None = None,
    ctx: Context = None,
) -> str:
    """Create a workspace loop template as an unpublished draft. Not
    idempotent: a repeated slug is 409. Author large prompts in the UI or
    REST; MCP has garbled multi-KB strings.

    Args:
        workspace_slug: Workspace slug.
        slug: URL-safe, unique in the workspace.
        name: Display name.
        content: {system_prompt, loop_prompt, slots, tools, rails_defaults, ...}.
        profile: {emoji, tagline, tags}.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        "slug": slug,
        "name": name,
        "content": content or {},
        "profile": profile or {},
    }
    result = await client.post(_templates(client, workspace_slug), body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_loop_template(
    workspace_slug: str,
    ref: str,
    content: dict | None = None,
    profile: dict | None = None,
    name: str | None = None,
    expected_updated_at: str | None = None,
    ctx: Context = None,
) -> str:
    """Autosave a workspace template's DRAFT. Omitted fields are unchanged;
    `content` and `profile` replace the whole object (no deep merge). System
    templates are immutable: duplicate first.

    Args:
        workspace_slug: Workspace slug.
        ref: Workspace template UUID or slug.
        content: Full replacement body.
        profile: Full replacement {emoji, tagline, tags}.
        name: New display name.
        expected_updated_at: Optimistic lock: `draft_updated_at` last read; 409 on conflict.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        key: value
        for key, value in {
            "content": content,
            "profile": profile,
            "name": name,
            "expected_updated_at": expected_updated_at,
        }.items()
        if value is not None
    }
    if not body:
        return json.dumps(
            {"error": "nothing to change — pass content, profile, or name"},
            indent=2,
        )
    result = await client.patch(f"{_templates(client, workspace_slug)}/{ref}", body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def publish_loop_template(
    workspace_slug: str,
    ref: str,
    expected_version: int | None = None,
    note: str | None = None,
    ctx: Context = None,
) -> str:
    """Validate the draft, snapshot a new version and publish it; bound boards
    show drift until re-rendered. Invalid draft: 422 with per-field findings.

    Args:
        workspace_slug: Workspace slug.
        ref: Workspace template UUID or slug.
        expected_version: Optimistic lock.
        note: Changelog line (<= 500 chars).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        key: value
        for key, value in {"expected_version": expected_version, "note": note}.items()
        if value is not None
    }
    result = await client.post(f"{_templates(client, workspace_slug)}/{ref}/publish", body)
    result["_hint"] = (
        "Published. Boards already bound to this template keep their current "
        "prompts and now show drift — re-render each with set_board_loop "
        "(template_ref + slot_values) to pick this version up."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def duplicate_loop_template(
    workspace_slug: str,
    ref: str,
    new_slug: str | None = None,
    ctx: Context = None,
) -> str:
    """Fork a system or workspace template into a new workspace draft; how a
    system template gets customized.

    Args:
        workspace_slug: Workspace slug.
        ref: System slug or template UUID.
        new_slug: Slug for the copy; omit to derive one.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {} if new_slug is None else {"new_slug": new_slug}
    result = await client.post(f"{_templates(client, workspace_slug)}/{ref}/duplicate", body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def archive_loop_template(
    workspace_slug: str, ref: str, archived: bool = True, ctx: Context = None
) -> str:
    """Soft-archive a workspace template (archived=False restores). Archived
    templates keep serving bound boards; there is no hard delete.

    Args:
        workspace_slug: Workspace slug.
        ref: Workspace template UUID or slug.
        archived: False to restore.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    action = "archive" if archived else "unarchive"
    result = await client.post(f"{_templates(client, workspace_slug)}/{ref}/{action}")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_loop_template_versions(workspace_slug: str, ref: str, ctx: Context = None) -> str:
    """List a template's published versions, newest first: version, timestamp, note.

    Args:
        workspace_slug: Workspace slug.
        ref: System slug or template UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{_templates(client, workspace_slug)}/{ref}/versions")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def restore_loop_template_version(
    workspace_slug: str, ref: str, version: int, ctx: Context = None
) -> str:
    """Stage a published version as the current draft. Does not republish.

    Args:
        workspace_slug: Workspace slug.
        ref: Workspace template UUID or slug.
        version: Published version number to stage.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(
        f"{_templates(client, workspace_slug)}/{ref}/versions/{version}/restore"
    )
    result["_hint"] = (
        "Staged as the draft — the published version is unchanged. Call "
        "publish_loop_template to make this the live version."
    )
    return json.dumps(result, indent=2, default=str)


async def _board_loop_binding(client, workspace_slug: str, board_id: str, include_diff: bool) -> dict:
    board_path = client.board(workspace_slug, board_id)
    result = await client.get(f"{board_path}/loop/binding")
    if include_diff and result.get("diff_available"):
        result["diff"] = await client.get(f"{board_path}/loop/binding/diff")
    return result


@mcp.tool()
@handle_api_errors
async def get_board_loop_binding_raw(
    workspace_slug: str,
    board_id: str,
    include_diff: bool = False,
    ctx: Context = None,
) -> str:
    """Raw view of a board's template binding: template, version, rendered
    slot values, drift — the authoring state behind get_board_loop, which is
    the effective loop config. 404 `not_bound` when the board's prompts are raw.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        include_diff: Also fetch the prompt diff and slot delta vs. the current version (skipped when `diff_available` is false).
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _board_loop_binding(app.client, workspace_slug, board_id, include_diff)
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def get_board_loop_binding(
    workspace_slug: str,
    board_id: str,
    include_diff: bool = False,
    ctx: Context = None,
) -> str:
    """Read a board's template binding (raw view).

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        include_diff: Also fetch the prompt diff and slot delta.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _board_loop_binding(app.client, workspace_slug, board_id, include_diff)
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def check_loop_template_fit(
    workspace_slug: str,
    board_id: str,
    template_ref: str,
    ctx: Context = None,
) -> str:
    """Board pre-flight for a template.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        template_ref: System slug or template UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _template_fit(app.client, workspace_slug, board_id, template_ref)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def apply_loop_template_fixes(
    workspace_slug: str,
    board_id: str,
    template_ref: str,
    fix_ids: list[str],
    ctx: Context = None,
) -> str:
    """Apply named fixes from a fit report, then return the fresh report.
    Idempotent per fix (`skipped_already_satisfied`); unknown fix ids are 422
    before anything applies; a frozen board 409s.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        template_ref: System slug or template UUID.
        fix_ids: `fix_id` values from check_loop_template_fit.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.post(
        f"{client.board(workspace_slug, board_id)}/loop-templates/{template_ref}/fit/apply",
        {"fix_ids": fix_ids},
    )
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def preview_loop_template(
    workspace_slug: str,
    template_ref: str,
    slot_values: dict[str, Any] | None = None,
    board_id: str | None = None,
    include_prompts: bool = True,
    ctx: Context = None,
) -> str:
    """Render a template's prompts without binding (dry run).

    Args:
        workspace_slug: Workspace slug.
        template_ref: System slug or template UUID.
        slot_values: Slot name -> value.
        board_id: Board to render for.
        include_prompts: False to omit prompt bodies.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _template_preview(app.client, workspace_slug, template_ref, slot_values, board_id, include_prompts)
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def lint_loop_template(
    workspace_slug: str,
    template_ref: str,
    ctx: Context = None,
) -> str:
    """Report repo-specific facts in a template.

    Args:
        workspace_slug: Workspace slug.
        template_ref: System slug or template UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _template_lint(app.client, workspace_slug, template_ref)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def export_loop_template(
    workspace_slug: str,
    template_ref: str,
    ctx: Context = None,
) -> str:
    """Export a template as a portable `loop_template` envelope for
    import_loop_template. System templates export too. `data.leak_findings`
    carries lint hints as warnings; export always succeeds.

    Args:
        workspace_slug: Source workspace slug.
        template_ref: System slug or template UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(
        f"{_templates(client, workspace_slug)}/{template_ref}/export"
    )
    leaks = (result.get("data") or {}).get("leak_findings") or []
    result["_hint"] = (
        f"{len(leaks)} repo-specific fact(s) in data.leak_findings — move each "
        "into a slot before sharing, or the template only works here."
        if leaks
        else "Portable: no repo-specific facts detected. Import with "
        "import_loop_template (dry-run first)."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def import_loop_template(
    workspace_slug: str,
    bundle: dict,
    dry_run: bool = True,
    ctx: Context = None,
) -> str:
    """Import a `loop_template` envelope as an unpublished DRAFT. Dry-run by
    default: returns {action, findings, diff_summary, leak_findings}, writes
    nothing; dry_run=false adds `template_id`. A matching slug overwrites
    that draft (`action` updated|created). Over ~64 KB, POST
    /loop-templates/import directly.

    Args:
        workspace_slug: Target workspace slug.
        bundle: Envelope from export_loop_template.
        dry_run: False to apply.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    flag = "true" if dry_run else "false"
    result = await client.post(
        f"{_templates(client, workspace_slug)}/import?dry_run={flag}", bundle
    )
    result["_hint"] = (
        "Preview only — nothing was written. Re-call with dry_run=false to apply."
        if result.get("dry_run")
        else "Imported as an unpublished DRAFT: no bound board changed. Review "
        "it, then publish_loop_template to make it runnable."
    )
    return json.dumps(result, indent=2, default=str)
