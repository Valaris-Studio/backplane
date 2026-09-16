# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp

# Explicit structured definition fields, in the order the backend's
# DefinitionContent schema documents them. Each maps to a key inside `content`.
# Kept here so create_board can reuse the exact same assembly logic.
_STRUCTURED_FIELDS = (
    "objectives",
    "exclusions",
    "milestones",
    "tech_stack",
    "stakeholders",
    "constraints",
    "decisions",
    "references",
    "custom_fields",
    "coding_standards",
)


def build_definition_body(
    scope: str | None,
    content: dict | None,
    structured: dict,
) -> dict:
    """Assemble the PUT body for a definition upsert.

    Merges explicit structured params over any raw `content` passthrough so
    LLM callers can author known fields ergonomically while still forwarding
    unknown/forward-compat keys. Returns a body with `scope` and/or `content`
    keys, omitting either when nothing was provided (keeps PUT a no-op merge).
    """
    body: dict = {}
    if scope is not None:
        body["scope"] = scope
    merged = dict(content) if content else {}
    for key, value in structured.items():
        if value is not None:
            merged[key] = value
    if merged:
        body["content"] = merged
    return body


@mcp.tool()
@handle_api_errors
async def get_definition(
    workspace_slug: str,
    board_id: str,
    ctx: Context = None,
) -> str:
    """Get a board's definition: scope plus structured content.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.board(workspace_slug, board_id)}/definitions")
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def update_definition(
    workspace_slug: str,
    board_id: str,
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
    content: dict | None = None,
    ctx: Context = None,
) -> str:
    """Upsert a board's definition. Shallow merge: only given keys are replaced.
    Explicit params win over the same key in `content`.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        scope: Summary paragraph.
        objectives: [{"text", "priority"?}].
        exclusions: Out-of-scope items.
        milestones: [{"title", "date", "type"?}].
        tech_stack: ["python", "react", ...].
        stakeholders: [{"name", "role"?, "member_id"?, "channel_id"?}].
        constraints: Hard constraints.
        decisions: [{"decision", "rationale"?}].
        references: [{"url", "label"?}].
        custom_fields: [{"key", "value"?}].
        coding_standards: Free-text conventions.
        content: Raw dict for keys with no dedicated param.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    structured = {
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
    }
    body = build_definition_body(scope, content, structured)
    result = await client.put(
        f"{client.board(workspace_slug, board_id)}/definitions", body
    )
    return json.dumps(result, indent=2, default=str)
