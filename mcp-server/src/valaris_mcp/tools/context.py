# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp

# The /context briefing embeds a small board summary, but the definition, notes,
# and recent-activity sections are unbounded and can push the composite past the
# MCP token cap (a real prod board overflowed at ~54KB, almost all notes +
# definition). Cap each heavy section and leave a marker + _hint so the caller
# knows what was dropped and which tool fetches the rest.
MAX_NOTES = 25
MAX_ACTIVITY = 20
MAX_DEFINITION_FIELD_CHARS = 4000
# Backstop on the WHOLE definition section: bloat can hide in a long list field
# or be spread across many sub-limit string leaves, so a per-field cap alone
# can't bound it. If the serialized definition still exceeds this, drop content
# down to the scope + a pointer to get_definition.
MAX_DEFINITION_TOTAL_CHARS = 8000

_TRUNCATION_SUFFIX = "… [truncated]"


def _cap_list(items: list, limit: int) -> tuple[list, int]:
    """Return (capped_items, dropped_count)."""
    if len(items) <= limit:
        return items, 0
    return items[:limit], len(items) - limit


def _truncate_definition(definition: dict | None) -> bool:
    """Bound definition.content in place. Returns True if anything was trimmed.

    Two passes: (1) truncate any oversized string leaf; (2) if the whole section
    is still over the total budget, collapse content to a pointer (the full
    structured definition is one get_definition call away).
    """
    if not definition:
        return False
    content = definition.get("content")
    if not isinstance(content, dict):
        return False

    truncated = False
    for key, value in content.items():
        if isinstance(value, str) and len(value) > MAX_DEFINITION_FIELD_CHARS:
            content[key] = value[:MAX_DEFINITION_FIELD_CHARS] + _TRUNCATION_SUFFIX
            truncated = True

    if len(json.dumps(content, default=str)) > MAX_DEFINITION_TOTAL_CHARS:
        definition["content"] = {
            "_note": "definition content omitted (too large) — use get_definition for the full structured definition."
        }
        truncated = True

    return truncated


@mcp.tool()
@handle_api_errors
async def get_project_context(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Get a full board briefing in one call: board summary, definition, notes, git repos, recent activity. The recommended first call for any board workflow.

    Board section is per-column counts only. Notes, definition, and activity are capped; a trimmed section carries a _..._truncated marker and a _hint naming the tool with the full data.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    result = await client.get(f"{client.board(workspace_slug, board_id)}/context")

    hints: list[str] = []

    notes, notes_dropped = _cap_list(result.get("notes") or [], MAX_NOTES)
    if notes_dropped:
        result["notes"] = notes
        result["_notes_truncated"] = notes_dropped
        hints.append(f"{notes_dropped} more note(s) omitted — use list_notes for the full list.")

    activity, activity_dropped = _cap_list(result.get("recent_activity") or [], MAX_ACTIVITY)
    if activity_dropped:
        result["recent_activity"] = activity
        result["_activity_truncated"] = activity_dropped
        hints.append(
            f"{activity_dropped} older activity row(s) omitted — use list_activity for more."
        )

    if _truncate_definition(result.get("definition")):
        result["_definition_truncated"] = True
        hints.append("definition fields truncated — use get_definition for the full text.")

    if hints:
        result["_hint"] = " ".join(hints)

    return json.dumps(result, indent=2, default=str)
