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
# Backstop on the WHOLE rendered briefing: no section — including ones the
# backend does not bound (git repos, column count, free-text leaves) or an older
# backend that sends uncapped status counts — may overflow it. Over budget,
# sections degrade in a fixed order, cheapest-to-refetch first, until it fits.
MAX_PROJECT_CONTEXT_CHARS = 32_000
BACKSTOP_NOTES = 10
BACKSTOP_ACTIVITY = 5
BACKSTOP_GIT_REPOS = 5
BACKSTOP_COLUMNS = 30
# Last resort: every string, list and dict is clipped, which bounds the reply
# whatever shape the payload has (30 columns x clipped core fields fits).
BACKSTOP_LEAF_CHARS = 120
BACKSTOP_LEAF_ITEMS = 30
# Headroom for the _size_capped/_hint markers the backstop itself adds (every
# step's hint together is ~700 chars).
_BACKSTOP_MARKER_RESERVE_CHARS = 1_200
_COLUMN_CORE_FIELDS = ("id", "name", "column_type", "position", "card_count")

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


def _render(result: dict) -> str:
    return json.dumps(result, indent=2, default=str)


def _collapse_status_counts(result: dict) -> str:
    board = result.get("board")
    for column in (board.get("columns") or []) if isinstance(board, dict) else []:
        distribution = column.get("status_distribution")
        if isinstance(distribution, dict) and distribution:
            column["status_distribution"] = {"_other": sum(distribution.values())}
    return "per-column status counts collapsed — use list_cards/search_cards for card statuses."


def _shrink_list(result: dict, key: str, marker: str, keep: int) -> None:
    items = result.get(key) or []
    if len(items) > keep:
        result[marker] = result.get(marker, 0) + len(items) - keep
        result[key] = items[:keep]


def _shrink_notes(result: dict) -> str:
    _shrink_list(result, "notes", "_notes_truncated", BACKSTOP_NOTES)
    return "notes list shortened — use list_notes for the full list."


def _shrink_activity(result: dict) -> str:
    _shrink_list(result, "recent_activity", "_activity_truncated", BACKSTOP_ACTIVITY)
    return "activity shortened — use list_activity for more."


def _omit_definition_content(result: dict) -> str:
    definition = result.get("definition")
    if isinstance(definition, dict) and "content" in definition:
        definition["content"] = {"_note": "definition content omitted — use get_definition."}
        result["_definition_truncated"] = True
    return "definition content omitted — use get_definition."


def _strip_column_detail(result: dict) -> str:
    board = result.get("board")
    if isinstance(board, dict) and board.get("columns"):
        board["columns"] = [
            {k: col[k] for k in _COLUMN_CORE_FIELDS if k in col} for col in board["columns"]
        ]
    return "column distributions dropped — use get_board_health or list_cards."


def _drop_notes_and_activity(result: dict) -> str:
    _shrink_list(result, "notes", "_notes_truncated", 0)
    _shrink_list(result, "recent_activity", "_activity_truncated", 0)
    return "notes and activity omitted — use list_notes / list_activity."


def _shrink_git_repos(result: dict) -> str:
    _shrink_list(result, "git_repos", "_git_repos_truncated", BACKSTOP_GIT_REPOS)
    return "git repos shortened — use list_git_repos for the full list."


def _shrink_columns(result: dict) -> str:
    board = result.get("board")
    columns = board.get("columns") if isinstance(board, dict) else None
    if isinstance(columns, list) and len(columns) > BACKSTOP_COLUMNS:
        result["_columns_truncated"] = len(columns) - BACKSTOP_COLUMNS
        board["columns"] = columns[:BACKSTOP_COLUMNS]
    return "columns list shortened — use get_board for every column."


def _clip_leaf(value):
    if isinstance(value, str) and len(value) > BACKSTOP_LEAF_CHARS:
        return value[: BACKSTOP_LEAF_CHARS - 1] + "…"
    if isinstance(value, list):
        return [_clip_leaf(item) for item in value[:BACKSTOP_LEAF_ITEMS]]
    if isinstance(value, dict):
        kept = list(value.items())[:BACKSTOP_LEAF_ITEMS]
        return {key[:BACKSTOP_LEAF_CHARS]: _clip_leaf(item) for key, item in kept}
    return value


def _clip_leaves(result: dict) -> str:
    for key in list(result):
        if not key.startswith("_"):
            result[key] = _clip_leaf(result[key])
    return "long text and lists clipped — fetch the section's own tool for full values."


_BACKSTOP_STEPS = (
    ("status_counts", _collapse_status_counts),
    ("notes", _shrink_notes),
    ("activity", _shrink_activity),
    ("definition", _omit_definition_content),
    ("column_detail", _strip_column_detail),
    ("notes_and_activity", _drop_notes_and_activity),
    ("git_repos", _shrink_git_repos),
    ("columns", _shrink_columns),
    ("leaves", _clip_leaves),
)


def _enforce_total_budget(result: dict, hints: list[str]) -> None:
    applied: list[str] = []
    for step_name, degrade in _BACKSTOP_STEPS:
        if len(_render(result)) + _BACKSTOP_MARKER_RESERVE_CHARS <= MAX_PROJECT_CONTEXT_CHARS:
            break
        hints.append(degrade(result))
        applied.append(step_name)
        result["_size_capped"] = applied


@mcp.tool()
@handle_api_errors
async def get_project_context(workspace_slug: str, board_id: str, ctx: Context = None) -> str:
    """Full board briefing in one call (counts, definition, notes, repos, activity); the recommended first call. See docs.

    Args:
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

    _enforce_total_budget(result, hints)

    if hints:
        result["_hint"] = " ".join(hints)

    return _render(result)
