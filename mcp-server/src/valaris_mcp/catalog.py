# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The one table describing every registered tool, and the seam that applies it.

`TOOL_META` carries category/kind/annotation facts per tool (parity-tested
against the frontend MCP reference data). `finalize_tool_surface` runs once at
import time, after every tool module has registered, and rewrites what goes
on the wire: title + MCP annotations, structured output off, the docstring's
`Args:` block moved into per-parameter schema descriptions, and the redundant
schema `title`s stripped. Must not import `valaris_mcp.server` at module
level — server.py imports this module.
"""
from __future__ import annotations

import asyncio
import inspect
import re
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Iterable, Literal

from mcp.server.fastmcp.utilities.func_metadata import func_metadata
from mcp.types import ToolAnnotations

GROUPS: tuple[str, ...] = (
    "Start here",
    "Work management",
    "Knowledge & content",
    "Collaboration",
    "Autonomous operations",
)

_NON_SLUG_RUN_RE = re.compile(r"[^a-z0-9]+")


def slugify(title: str) -> str:
    """Lowercase, runs of non-alphanumerics to one dash, dashes trimmed at both ends."""
    return _NON_SLUG_RUN_RE.sub("-", title.lower()).strip("-")


# Toolset ids for the groups (frontend derives the same list with the same
# rule; test_tool_catalog_parity.py pins the match).
GROUP_IDS: tuple[tuple[str, str], ...] = tuple((slugify(title), title) for title in GROUPS)


@dataclass(frozen=True)
class Category:
    id: str
    title: str
    group: str


# Same ids/titles/groups/order as frontend mcp-reference/data/categories.ts
# (blurbs stay frontend-only); test_tool_catalog_parity.py pins the match.
CATEGORIES: tuple[Category, ...] = (
    Category("context", "Project Context", "Start here"),
    Category("search", "Search", "Start here"),
    Category("assignments", "Assignments", "Start here"),
    Category("bulk", "Bulk Operations", "Start here"),
    Category("health", "Board Health", "Start here"),
    Category("server-info", "Server Info", "Start here"),
    Category("workspaces", "Workspaces", "Work management"),
    Category("boards", "Boards", "Work management"),
    Category("columns", "Columns", "Work management"),
    Category("cards", "Cards", "Work management"),
    Category("card-dependencies", "Card Dependencies", "Work management"),
    Category("notes", "Notes", "Knowledge & content"),
    Category("definitions", "Definitions", "Knowledge & content"),
    Category("resources", "Resources", "Knowledge & content"),
    Category("activity", "Activity", "Knowledge & content"),
    Category("teams", "Teams", "Collaboration"),
    Category("channels", "Channels", "Collaboration"),
    Category("git-repos", "Git Repos", "Collaboration"),
    Category("webhooks", "Webhooks", "Collaboration"),
    Category("agents-executions", "Agents & Executions", "Autonomous operations"),
    Category("approvals", "Approvals", "Autonomous operations"),
    Category("merge-queue", "Merge Queue", "Autonomous operations"),
    Category("workspace-config", "Workspace Config", "Autonomous operations"),
    Category("prompt-configs", "Prompt Configs", "Autonomous operations"),
    Category("loop-templates", "Loop Templates", "Autonomous operations"),
    Category("skills", "Skills", "Autonomous operations"),
)


# Retired and renamed tools stay registered as deprecated aliases for ONE minor
# version, then go. Bump when the aliases are dropped and the next batch begins.
DEPRECATION_REMOVAL_VERSION = "0.9.0"


@dataclass(frozen=True)
class ToolMeta:
    category: str
    kind: Literal["read", "write", "composite"]
    destructive: bool = False  # meaningful only when not read-only
    idempotent: bool = False
    read_only: bool | None = None  # None => derived from kind == "read"
    title: str | None = None  # None => humanised tool name
    # Set on a deprecated alias: the replacement call, as prose the model can
    # act on (e.g. "update_note(mode='append')"). An alias is hidden from every
    # toolset, counted apart from the live surface, and flagged on the wire.
    deprecated_for: str | None = None


# category/kind mirror the frontend ToolDoc entries. destructive = the verb set
# (delete_/hard_delete_/remove_/cancel_/archive_) plus tools that overwrite or
# halt state in bulk. idempotent only where the docstring/backend promises a
# repeat call is a no-op (PATCH/set family, "already ... returns" contracts).
TOOL_META: dict[str, ToolMeta] = {
    "get_completion_policy": ToolMeta("merge-queue", "read", idempotent=True),
    "get_completion_status": ToolMeta("merge-queue", "read", idempotent=True),
    "submit_completion_candidate": ToolMeta("merge-queue", "write", idempotent=True),
    "request_landing": ToolMeta("merge-queue", "write", idempotent=True),
    "retry_completion": ToolMeta("merge-queue", "write", idempotent=True),

    "list_documentation": ToolMeta("context", "read", title="List product documentation"),
    "read_documentation": ToolMeta("context", "read", title="Read product documentation"),
    "activate_catalog_skill": ToolMeta("skills", "write", idempotent=True),
    "add_card_dependency": ToolMeta("card-dependencies", "write", idempotent=True),
    "add_card_participant": ToolMeta("cards", "write", idempotent=True),
    "add_team_member": ToolMeta("teams", "write", idempotent=True),
    "add_workspace_member": ToolMeta("workspaces", "write", idempotent=True),
    "append_note": ToolMeta("notes", "write", deprecated_for="update_note(mode='append')"),
    "apply_loop_template_fixes": ToolMeta(
        "loop-templates", "write", destructive=True, idempotent=True
    ),
    "archive_loop_template": ToolMeta("loop-templates", "write", destructive=True),
    "bulk_create_cards": ToolMeta("bulk", "composite"),
    "bulk_set_card_dependencies": ToolMeta("card-dependencies", "composite"),
    "cancel_execution": ToolMeta("agents-executions", "write", destructive=True),
    "cancel_merge_queue_entry": ToolMeta("merge-queue", "write", destructive=True),
    "check_loop_template_fit": ToolMeta(
        "loop-templates", "read", deprecated_for="get_loop_template(view='fit', board_id=...)"
    ),
    "claim_card": ToolMeta(
        "cards",
        "composite",
        deprecated_for="next_assignment (runners) or move_card + add_card_participant (interactive)",
    ),
    "create_agent": ToolMeta("agents-executions", "write"),
    "create_board": ToolMeta("boards", "write"),
    "create_card": ToolMeta("cards", "write"),
    "create_channel": ToolMeta("channels", "write"),
    "create_column": ToolMeta("columns", "write"),
    "create_git_repo": ToolMeta("git-repos", "write"),
    "create_loop_template": ToolMeta("loop-templates", "write"),
    "create_note": ToolMeta("notes", "write"),
    "create_prompt_config": ToolMeta("prompt-configs", "write"),
    "create_resource": ToolMeta("resources", "write"),
    "create_team": ToolMeta("teams", "write"),
    "create_webhook": ToolMeta("webhooks", "write"),
    "create_workspace": ToolMeta("workspaces", "write"),
    "deactivate_team": ToolMeta("teams", "write", destructive=True),
    "decide_approval": ToolMeta("approvals", "write"),
    "delete_board": ToolMeta("boards", "write", destructive=True),
    "delete_card": ToolMeta("cards", "write", destructive=True),
    "delete_channel": ToolMeta("channels", "write", destructive=True),
    "delete_column": ToolMeta("columns", "write", destructive=True),
    "delete_git_repo": ToolMeta("git-repos", "write", destructive=True),
    "delete_note": ToolMeta("notes", "write", destructive=True),
    "delete_prompt_config": ToolMeta("prompt-configs", "write", destructive=True),
    "delete_resource": ToolMeta("resources", "write", destructive=True),
    "delete_webhook": ToolMeta(
        "webhooks", "write", destructive=True, deprecated_for="update_webhook(delete=True)"
    ),
    "delete_workspace": ToolMeta("workspaces", "write", destructive=True),
    "duplicate_loop_template": ToolMeta("loop-templates", "write"),
    "enable_toolsets": ToolMeta(
        "server-info", "write", destructive=False, idempotent=True, read_only=False,
        title="Enable toolsets",
    ),
    "enqueue_for_merge": ToolMeta("merge-queue", "write", idempotent=True),
    "enqueue_pr_for_merge": ToolMeta("merge-queue", "write", idempotent=True),
    "export_loop_template": ToolMeta("loop-templates", "composite", read_only=True),
    "export_pipeline_bundle": ToolMeta("workspace-config", "composite", read_only=True),
    "freeze_board": ToolMeta("boards", "write", destructive=True, idempotent=True),
    "get_agent": ToolMeta("agents-executions", "read"),
    "get_agent_budget_status": ToolMeta("agents-executions", "read"),
    "get_agent_config": ToolMeta("agents-executions", "read"),
    "get_approval_status": ToolMeta("approvals", "read"),
    "get_board": ToolMeta("boards", "read"),
    "get_board_health": ToolMeta("health", "read"),
    "get_board_loop": ToolMeta("boards", "read"),
    "get_board_loop_binding": ToolMeta(
        "loop-templates", "read", deprecated_for="get_board_loop_binding_raw"
    ),
    "get_board_loop_binding_raw": ToolMeta("loop-templates", "read"),
    "get_card": ToolMeta("cards", "read"),
    "get_card_dependency_status": ToolMeta("card-dependencies", "read"),
    "get_card_verdict": ToolMeta("card-dependencies", "read"),
    "get_definition": ToolMeta("definitions", "read"),
    "get_download_url": ToolMeta("resources", "read"),
    "get_loop_template": ToolMeta("loop-templates", "read"),
    "get_loop_template_profile": ToolMeta(
        "loop-templates", "read", deprecated_for="get_loop_template(view='profile')"
    ),
    "get_merge_queue_entry": ToolMeta("merge-queue", "read"),
    "get_note": ToolMeta("notes", "read"),
    "get_pipeline_sensors": ToolMeta("workspace-config", "read"),
    "get_project_context": ToolMeta("context", "composite", read_only=True),
    "get_prompt_config": ToolMeta("prompt-configs", "read"),
    "get_resource": ToolMeta("resources", "read"),
    "get_server_info": ToolMeta("server-info", "read"),
    "get_skill": ToolMeta("skills", "read"),
    "get_team": ToolMeta("teams", "read"),
    "get_upload_url": ToolMeta("resources", "write"),
    "get_webhook": ToolMeta("webhooks", "read"),
    "get_workspace": ToolMeta("workspaces", "read"),
    "get_workspace_config": ToolMeta("workspace-config", "read"),
    "get_workspace_cost": ToolMeta(
        "agents-executions", "read", deprecated_for="get_workspace_metrics(view='cost')"
    ),
    "get_workspace_metrics": ToolMeta("agents-executions", "read"),
    "get_workspace_summary": ToolMeta("workspaces", "composite", read_only=True),
    "get_workspace_velocity": ToolMeta(
        "agents-executions", "read", deprecated_for="get_workspace_metrics(view='velocity')"
    ),
    "hard_delete_agent": ToolMeta(
        "agents-executions",
        "write",
        destructive=True,
        deprecated_for="update_agent(hard_delete=True)",
    ),
    "import_loop_template": ToolMeta("loop-templates", "composite", destructive=True),
    "import_pipeline_bundle": ToolMeta(
        "workspace-config", "composite", destructive=True, idempotent=True
    ),
    "lint_loop_template": ToolMeta(
        "loop-templates", "read", deprecated_for="get_loop_template(view='lint')"
    ),
    "list_activity": ToolMeta("activity", "read"),
    "list_agents": ToolMeta("agents-executions", "read"),
    "list_approvals": ToolMeta("approvals", "read"),
    "list_boards": ToolMeta("boards", "read"),
    "list_card_dependencies": ToolMeta("card-dependencies", "read"),
    "list_cards": ToolMeta("cards", "read"),
    "list_channels": ToolMeta("channels", "read"),
    "list_executions": ToolMeta("agents-executions", "read"),
    "list_git_repos": ToolMeta("git-repos", "read"),
    "list_loop_template_versions": ToolMeta("loop-templates", "read"),
    "list_loop_templates": ToolMeta("loop-templates", "read"),
    "list_merge_queue": ToolMeta("merge-queue", "read"),
    "list_notes": ToolMeta("notes", "read"),
    "list_prompt_configs": ToolMeta("prompt-configs", "read"),
    "list_resources": ToolMeta("resources", "read"),
    "list_skill_bindings": ToolMeta("skills", "read", deprecated_for="list_skill_bindings_raw"),
    "list_skill_bindings_raw": ToolMeta("skills", "read"),
    "list_skill_catalog": ToolMeta("skills", "read"),
    "list_skills": ToolMeta("skills", "read"),
    "list_teams": ToolMeta("teams", "read"),
    "list_webhooks": ToolMeta("webhooks", "read"),
    "list_workspace_members": ToolMeta("workspaces", "read"),
    "list_workspaces": ToolMeta("workspaces", "read"),
    "log_execution_start": ToolMeta("agents-executions", "write"),
    "log_execution_update": ToolMeta("agents-executions", "write"),
    "move_card": ToolMeta("cards", "write", idempotent=True),
    "next_assignment": ToolMeta("assignments", "composite"),
    "pause_agent": ToolMeta("agents-executions", "write", destructive=True, idempotent=True),
    "preview_loop_template": ToolMeta(
        "loop-templates", "read", deprecated_for="get_loop_template(view='preview')"
    ),
    "propose_skill": ToolMeta("skills", "write"),
    "publish_loop_template": ToolMeta("loop-templates", "write"),
    "remove_card_dependency": ToolMeta(
        "card-dependencies", "write", destructive=True, idempotent=True
    ),
    "remove_card_participant": ToolMeta("cards", "write", destructive=True, idempotent=True),
    "remove_card_participants_by_role": ToolMeta(
        "cards",
        "write",
        destructive=True,
        idempotent=True,
        deprecated_for="remove_card_participant(pipeline_role=...)",
    ),
    "remove_skill_binding": ToolMeta("skills", "write", destructive=True, idempotent=True),
    "remove_team_member": ToolMeta("teams", "write", destructive=True),
    "remove_workspace_member": ToolMeta("workspaces", "write", destructive=True),
    "reorder_columns": ToolMeta("columns", "write", idempotent=True),
    "replace_note_section": ToolMeta(
        "notes", "write", idempotent=True, deprecated_for="update_note(mode='section')"
    ),
    "request_approval": ToolMeta("approvals", "write"),
    "restart_agent": ToolMeta("agents-executions", "write"),
    "restore_loop_template_version": ToolMeta("loop-templates", "write"),
    "resume_agent": ToolMeta("agents-executions", "write", idempotent=True),
    "resume_cost_breaker": ToolMeta("workspace-config", "write"),
    "rotate_agent_key": ToolMeta("agents-executions", "write"),
    "search_cards": ToolMeta("search", "read"),
    "set_board_loop": ToolMeta("boards", "write", idempotent=True),
    "set_skill_binding": ToolMeta("skills", "write", idempotent=True),
    "unfreeze_board": ToolMeta("boards", "write", idempotent=True),
    "update_agent": ToolMeta("agents-executions", "write", destructive=True, idempotent=True),
    "update_board": ToolMeta("boards", "write", idempotent=True),
    "update_card": ToolMeta("cards", "write", idempotent=True),
    "update_channel": ToolMeta("channels", "write", idempotent=True),
    "update_column": ToolMeta("columns", "write", idempotent=True),
    "update_definition": ToolMeta("definitions", "write", idempotent=True),
    "update_git_repo": ToolMeta("git-repos", "write", idempotent=True),
    "update_loop_template": ToolMeta("loop-templates", "write", idempotent=True),
    "update_note": ToolMeta("notes", "write"),  # mode="append" is additive
    "update_prompt_config": ToolMeta(
        "prompt-configs", "write", destructive=True, idempotent=True
    ),
    "update_resource": ToolMeta("resources", "write", idempotent=True),
    "update_team": ToolMeta("teams", "write", idempotent=True),
    "update_webhook": ToolMeta("webhooks", "write", destructive=True, idempotent=True),
    "update_workspace_config": ToolMeta(
        "workspace-config", "write", destructive=True, idempotent=True
    ),
    "update_workspace_member": ToolMeta("workspaces", "write", idempotent=True),
    "validate_board_dependencies": ToolMeta("card-dependencies", "read"),
    "whoami": ToolMeta("server-info", "read", title="Who am I"),
}


def tool_title(name: str, meta: ToolMeta) -> str:
    title = meta.title or name.replace("_", " ").capitalize()
    return f"{title} (deprecated)" if meta.deprecated_for else title


def deprecated_aliases() -> dict[str, str]:
    """alias name -> replacement prose, in registration order."""
    return {name: meta.deprecated_for for name, meta in TOOL_META.items() if meta.deprecated_for}


def live_tool_names() -> list[str]:
    """Every tool that is not a deprecated alias — the surface counts describe."""
    return [name for name, meta in TOOL_META.items() if not meta.deprecated_for]


def deprecation_line(name: str, meta: ToolMeta) -> str:
    return (
        f"DEPRECATED, removed in backplane-mcp {DEPRECATION_REMOVAL_VERSION}: "
        f"call {meta.deprecated_for} instead of {name}."
    )


def tool_annotations(name: str, meta: ToolMeta) -> ToolAnnotations:
    read_only = meta.read_only if meta.read_only is not None else meta.kind == "read"
    if read_only:
        return ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
    return ToolAnnotations(
        readOnlyHint=False,
        destructiveHint=meta.destructive,
        idempotentHint=meta.idempotent,
    )


# Google-style `Args:` block after `inspect.cleandoc`: header at column 0,
# entries at exactly 4 spaces, continuation lines deeper. Any non-indented,
# non-blank line ends the block (a `Returns:` header or trailing prose).
_ARGS_HEADER_RE = re.compile(r"^Args:\s*$")
_ARG_ENTRY_RE = re.compile(r"^ {4}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$")
_CONTINUATION_RE = re.compile(r"^ {5,}(\S.*)$")


def split_docstring(doc: str) -> tuple[str, dict[str, str]]:
    """Split a tool docstring into (wire description, {arg: description}).

    Prose before `Args:` and any section after the block (e.g. `Returns:`)
    form the description, joined by a blank line; Args entries are joined
    single-spaced across continuation lines.
    """
    lines = inspect.cleandoc(doc).splitlines()
    before: list[str] = []
    after: list[str] = []
    args: dict[str, str] = {}
    state = "before"
    current: str | None = None
    for line in lines:
        if state == "before":
            if _ARGS_HEADER_RE.match(line):
                state = "args"
            else:
                before.append(line)
            continue
        if state == "args":
            if line.strip() == "":
                continue
            if not line.startswith(" "):
                state = "after"
                after.append(line)
                continue
            entry = _ARG_ENTRY_RE.match(line)
            if entry:
                current = entry.group(1)
                args[current] = entry.group(2).strip()
                continue
            continuation = _CONTINUATION_RE.match(line)
            if continuation and current is not None:
                args[current] = f"{args[current]} {continuation.group(1).strip()}".strip()
            continue
        after.append(line)
    parts = [part for part in ("\n".join(before).strip(), "\n".join(after).strip()) if part]
    return "\n\n".join(parts), args


def _check_coverage(registered: dict[str, Any], meta: dict[str, ToolMeta]) -> None:
    missing = sorted(set(registered) - set(meta))
    orphans = sorted(set(meta) - set(registered))
    if missing or orphans:
        raise RuntimeError(
            f"TOOL_META out of sync with the registry: missing={missing} orphans={orphans}"
        )
    # The table and the registration path must agree on what is deprecated:
    # an alias registered with @mcp.tool() would leak into the frontend
    # catalog (the backend drift test collects that decorator), and a live
    # tool registered via deprecated_tool() would stamp every result.
    from valaris_mcp.deprecation import DEPRECATED_MARKER  # avoid an import cycle at module load

    marked = {name for name, tool in registered.items() if getattr(tool.fn, DEPRECATED_MARKER, False)}
    tabled = {name for name, entry in meta.items() if entry.deprecated_for}
    if marked != tabled:
        raise RuntimeError(
            "deprecated aliases disagree: registered via deprecated_tool() but not in TOOL_META="
            f"{sorted(marked - tabled)}; in TOOL_META but registered as live={sorted(tabled - marked)}"
        )


def finalize_tool_surface(server: Any) -> None:
    """Apply TOOL_META to every registered tool and slim the wire payload.

    Call once after every tool module has been imported. Reads `TOOL_META`
    at call time so tests can monkeypatch it.
    """
    registered: dict[str, Any] = server._tool_manager._tools
    _check_coverage(registered, TOOL_META)
    for name, tool in registered.items():
        meta = TOOL_META[name]
        tool.title = tool_title(name, meta)
        tool.annotations = tool_annotations(name, meta)

        # Structured output off: call results stay plain text, no outputSchema.
        tool.fn_metadata = func_metadata(
            tool.fn,
            skip_names=[tool.context_kwarg] if tool.context_kwarg else [],
            structured_output=False,
        )
        tool.__dict__.pop("output_schema", None)  # cached_property

        description, arg_docs = split_docstring(tool.fn.__doc__ or "")
        properties: dict[str, dict[str, Any]] = tool.parameters.get("properties", {})
        unknown = sorted(set(arg_docs) - set(properties))
        if unknown:
            raise RuntimeError(
                f"tool {name}: Args entries name parameters not in its schema: {unknown}"
            )
        for arg, text in arg_docs.items():
            properties[arg]["description"] = text
        if meta.deprecated_for:
            description = f"{deprecation_line(name, meta)} {description}".strip()
            tool.meta = {
                "deprecated": {
                    "replacement": meta.deprecated_for,
                    "removed_in": DEPRECATION_REMOVAL_VERSION,
                }
            }
        tool.description = description

        tool.parameters.pop("title", None)
        for prop in properties.values():
            prop.pop("title", None)
            # `T | None = None` params emit "default": null — pure bytes: an
            # absent default already means null, and call-time validation uses
            # fn_metadata.arg_model, not this schema.
            if "default" in prop and prop["default"] is None:
                del prop["default"]


def compact_listing_bytes(tools: Iterable[Any]) -> int:
    """Wire size of a `tools/list` result: compact JSON summed over MCPTool objects."""
    return sum(len(tool.model_dump_json(exclude_none=True, by_alias=True)) for tool in tools)


def _run_sync(coro_fn: Any) -> Any:
    # build_server_surface is a sync entry point (export script, sync tests);
    # if a loop is already running in this thread, run the coroutine on another.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro_fn())
    with ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(lambda: asyncio.run(coro_fn())).result()


def build_server_surface(server: Any) -> dict[str, Any]:
    """The machine-readable surface exported to the frontend docs fixture."""
    live = set(live_tool_names())
    # listing_bytes is the live surface's wire size — what the widest toolset
    # hand can list; deprecated aliases ride only on `all` and are capped apart.
    listed = [tool for tool in _run_sync(server.list_tools) if tool.name in live]
    tools: dict[str, Any] = {}
    for name, tool in server._tool_manager._tools.items():
        if TOOL_META[name].deprecated_for:
            continue  # aliases are listed under "deprecated", never as tools
        annotations = tool.annotations
        tools[name] = {
            "title": tool.title,
            "category": TOOL_META[name].category,
            "kind": TOOL_META[name].kind,
            "annotations": {
                "readOnlyHint": bool(annotations.readOnlyHint),
                "destructiveHint": bool(annotations.destructiveHint),
                "idempotentHint": bool(annotations.idempotentHint),
            },
            "description": tool.description,
            "params": {
                prop: spec.get("description")
                for prop, spec in tool.parameters.get("properties", {}).items()
            },
        }
    # Function-level import: toolsets.py depends on this module's tables.
    from valaris_mcp.toolsets import (
        DEFAULT_EXCLUSIONS,
        DEFAULT_INCLUSIONS,
        DEFAULT_TOOLSET_IDS,
        default_hand,
        toolset_catalog,
        tools_in_toolset,
    )

    toolsets = [
        {
            "id": entry["id"],
            "kind": entry["kind"],
            "title": entry["title"],
            "group": entry["group"],
            "tools": sorted(tools_in_toolset(entry["id"])),
        }
        for entry in toolset_catalog()
    ]
    return {
        "tool_count": len(tools),
        "listing_bytes": compact_listing_bytes(listed),
        "tools": tools,
        "deprecated": {
            name: {"replacement": replacement, "removed_in": DEPRECATION_REMOVAL_VERSION}
            for name, replacement in deprecated_aliases().items()
        },
        "toolsets": toolsets,
        "default_toolset": {
            "ids": list(DEFAULT_TOOLSET_IDS),
            "exclusions": dict(DEFAULT_EXCLUSIONS),
            "inclusions": dict(DEFAULT_INCLUSIONS),
            "tools": sorted(default_hand()),
        },
    }


def build_backend_toolsets(server: Any) -> dict[str, Any]:
    """The toolset table the backend validates SKILL.md `toolsets:` against.

    A projection of the frontend surface fixture so the backend, which cannot
    import this package, reads the same taxonomy from a checked-in JSON.
    """
    surface = build_server_surface(server)
    return {
        "toolsets": surface["toolsets"],
        "default": surface["default_toolset"],
        "tool_count": surface["tool_count"],
    }
