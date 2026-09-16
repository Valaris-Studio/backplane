# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp

MAX_SKILL_FILE_CHARS = 6000
_TRUNCATION_SUFFIX = "… [truncated]"


@mcp.tool()
@handle_api_errors
async def list_skills(
    workspace_slug: str,
    board_id: str | None = None,
    include_archived: bool = False,
    ctx: Context = None,
) -> str:
    """List workspace skills, or a board's effective skill set with board_id.
    Metadata only (incl. each skill's declared toolsets and, for a board, the
    toolsets its loop grant does not cover); get_skill returns the files.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug: return its effective set.
        include_archived: Include archived skills (workspace listing only).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    if board_id is not None:
        path = f"{client.board(workspace_slug, board_id)}/skills"
    else:
        path = f"{client.ws(workspace_slug)}/skills"
        if include_archived:
            path += "?include_archived=true"
    result = await client.get(path)
    skills = result.get("skills", [])
    return json.dumps(
        {
            "skills": skills,
            "count": len(skills),
            "_hint": (
                "Listings are metadata-only. Call get_skill(workspace_slug, slug) "
                "to fetch a skill's files, then write each one verbatim into your "
                "local skills dir to install it."
            ),
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def get_skill(
    workspace_slug: str,
    slug: str,
    version: int | None = None,
    file_path: str | None = None,
    ctx: Context = None,
) -> str:
    """Fetch a skill version's files verbatim (with its declared toolsets).
    Long files are truncated; re-fetch one whole with file_path.

    Args:
        workspace_slug: Workspace slug.
        slug: Skill slug.
        version: Omit for the latest published; pass explicitly for a draft.
        file_path: Return this one file in full.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    base = f"{client.ws(workspace_slug)}/skills/{slug}"
    if version is None:
        detail = await client.get(base)
        version = detail.get("latest_published_version")
        if version is None:
            return json.dumps(
                {
                    "skill": {
                        key: detail.get(key)
                        for key in (
                            "id",
                            "slug",
                            "name",
                            "description",
                            "latest_published_version",
                            "origin",
                            "toolsets",
                            "lint_warnings",
                        )
                    },
                    "files": [],
                    "_hint": (
                        "This skill has no published version yet. Fetch a draft "
                        "by passing version explicitly."
                    ),
                },
                indent=2,
                default=str,
            )
    result = dict(await client.get(f"{base}/versions/{version}"))
    files = [dict(file) for file in result.get("files", [])]
    if file_path is not None:
        matched = [file for file in files if file.get("path") == file_path]
        if not matched:
            available = ", ".join(file.get("path", "") for file in files)
            result["files"] = []
            result["_hint"] = (
                f"No file '{file_path}' in this version. Available files: {available}"
            )
            return json.dumps(result, indent=2, default=str)
        result["files"] = matched
        result["_hint"] = (
            "Full file content returned. Write it verbatim into your local skills dir."
        )
        return json.dumps(result, indent=2, default=str)
    truncated_count = 0
    for file in files:
        content = file.get("content", "")
        if len(content) > MAX_SKILL_FILE_CHARS:
            file["content"] = content[:MAX_SKILL_FILE_CHARS] + _TRUNCATION_SUFFIX
            truncated_count += 1
    result["files"] = files
    if truncated_count:
        result["_files_truncated"] = truncated_count
        result["_hint"] = (
            f"{truncated_count} file(s) exceeded {MAX_SKILL_FILE_CHARS} chars and "
            "were truncated — re-fetch each one in full with file_path."
        )
    else:
        result["_hint"] = (
            "Write each file verbatim into your local skills dir to install this skill."
        )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def propose_skill(
    workspace_slug: str,
    slug: str,
    files: list[dict],
    name: str | None = None,
    description: str | None = None,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Propose a new skill or version as a draft pending human approval;
    nothing is served until approved. Idempotent: returns the pending proposal.

    Args:
        workspace_slug: Workspace slug.
        slug: Skill slug to create or version.
        files: [{"path", "content"}], SKILL.md plus support files, verbatim.
        name: Omit to use SKILL.md frontmatter.
        description: Omit to use SKILL.md frontmatter.
        board_id: Originating board.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {"slug": slug, "files": files}
    if name is not None:
        body["name"] = name
    if description is not None:
        body["description"] = description
    if board_id is not None:
        body["board_id"] = board_id
    result = dict(
        await client.post(f"{client.ws(workspace_slug)}/skills/proposals", body)
    )
    result["_hint"] = (
        "Proposal submitted and pending human approval — nothing is published "
        "yet. Do NOT wait or poll for the decision: a human decides on their "
        "own schedule. Continue your work; if approved, the skill reaches "
        "future runs automatically."
    )
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def set_skill_binding(
    workspace_slug: str,
    board_id: str,
    skill_slug: str,
    enabled: bool | None = None,
    pinned_version: int | None = None,
    clear_pin: bool = False,
    ctx: Context = None,
) -> str:
    """Upsert a skill binding on a board: enable/disable, optionally pin a
    version. Omitted fields are unchanged (tri-state); new bindings default
    to enabled, unpinned.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        skill_slug: Workspace skill slug.
        enabled: Active on the board.
        pinned_version: Version to pin.
        clear_pin: Remove the pin; exclusive with pinned_version.
    """
    if clear_pin and pinned_version is not None:
        return json.dumps(
            {
                "error": True,
                "message": (
                    "pinned_version and clear_pin are mutually exclusive — "
                    "pass a version to pin, or clear_pin=true to unpin, "
                    "not both."
                ),
            },
            indent=2,
        )
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {}
    if enabled is not None:
        body["enabled"] = enabled
    if clear_pin:
        # Explicit null is the REST tri-state's unpin branch; omission means
        # "leave the pin unchanged".
        body["pinned_version"] = None
    elif pinned_version is not None:
        body["pinned_version"] = pinned_version
    result = await client.put(
        f"{client.board(workspace_slug, board_id)}/skills/{skill_slug}", body
    )
    result["_hint"] = (
        "Binding saved. Runners picking up work on this board (e.g. via "
        "next_assignment) now see this skill in the board's effective set."
    )
    return json.dumps(result, indent=2, default=str)


async def _skill_binding_rows(client, workspace_slug: str, board_id: str) -> dict:
    result = await client.get(f"{client.board(workspace_slug, board_id)}/skills/bindings")
    bindings = result.get("bindings", [])
    return {
        "bindings": bindings,
        "count": len(bindings),
        "_hint": (
            "These are raw binding rows — disabled bindings included. For "
            "the board's effective set (what callers actually get), call "
            "list_skills with board_id. Change a row with "
            "set_skill_binding; remove one with remove_skill_binding."
        ),
    }


@mcp.tool()
@handle_api_errors
async def list_skill_bindings_raw(
    workspace_slug: str,
    board_id: str,
    ctx: Context = None,
) -> str:
    """Raw view of a board's skill binding rows, disabled ones included;
    list_skills(board_id) is the effective set callers actually get.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _skill_binding_rows(app.client, workspace_slug, board_id)
    return json.dumps(result, indent=2, default=str)


@deprecated_tool()
@handle_api_errors
async def list_skill_bindings(
    workspace_slug: str,
    board_id: str,
    ctx: Context = None,
) -> str:
    """List a board's raw skill binding rows.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _skill_binding_rows(app.client, workspace_slug, board_id)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def remove_skill_binding(
    workspace_slug: str,
    board_id: str,
    skill_slug: str,
    ctx: Context = None,
) -> str:
    """Delete a board's skill binding row, pin included; disable via
    set_skill_binding to keep it. Idempotent.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID or slug.
        skill_slug: Bound skill slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    await client.delete(
        f"{client.board(workspace_slug, board_id)}/skills/{skill_slug}"
    )
    return json.dumps(
        {
            "removed": True,
            "board_id": board_id,
            "skill_slug": skill_slug,
            "_hint": (
                "Binding removed — the skill is unbound and any version pin is "
                "gone. To merely disable while keeping the pin, use "
                "set_skill_binding with enabled=false instead."
            ),
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def list_skill_catalog(
    workspace_slug: str,
    ctx: Context = None,
) -> str:
    """List the built-in skill catalog: curated bundles (each declaring the
    toolsets it plays in) not yet in the workspace library.

    Args:
        workspace_slug: Workspace slug.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.ws(workspace_slug)}/skill-catalog")
    entries = result.get("entries", [])
    return json.dumps(
        {
            "entries": entries,
            "count": len(entries),
            "_hint": (
                "Copy an entry into the workspace library with "
                "activate_catalog_skill(workspace_slug, catalog_id) — human "
                "sessions only — then bind it to boards with "
                "set_skill_binding."
            ),
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def activate_catalog_skill(
    workspace_slug: str,
    catalog_id: str,
    ctx: Context = None,
) -> str:
    """Copy a catalog skill into the workspace library as published v1. Human
    sessions only (runner keys 403). Idempotent.

    Args:
        workspace_slug: Workspace slug.
        catalog_id: Catalog entry id, from list_skill_catalog.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = dict(
        await client.post(
            f"{client.ws(workspace_slug)}/skill-catalog/{catalog_id}/activate"
        )
    )
    result["_hint"] = (
        "Skill activated into the workspace library as a published version. "
        "Bind it to a board with set_skill_binding so sessions on that board pick it up."
    )
    return json.dumps(result, indent=2, default=str)
