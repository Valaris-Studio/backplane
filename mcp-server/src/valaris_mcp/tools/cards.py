# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
from typing import Literal, get_args

from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp


def _cards_path(slug: str, board_id: str) -> str:
    return f"/workspaces/{slug}/boards/{board_id}/cards"


def _card_receipt(result: dict) -> str:
    if "description" in result:
        result = {
            **result,
            "_description_format": "prosemirror",
            "_hint": (
                "description is ProseMirror JSON, not markdown. Preserve your original markdown "
                "or use get_card for an editable markdown description before updating."
            ),
        }
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_cards(workspace_slug: str, board_id: str, ctx: Context) -> str:
    """List every card on a board, grouped by column.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    board = await client.get(client.board(workspace_slug, board_id))
    cards_by_column = []
    total = 0
    for column in board.get("columns", []):
        cards = column.get("cards", [])
        total += len(cards)
        cards_by_column.append(
            {
                "column_id": column["id"],
                "column_name": column["name"],
                "card_count": len(cards),
                "cards": cards,
            }
        )
    result = {"total_cards": total, "columns": cards_by_column}
    if total == 0:
        result["_hint"] = "No cards on this board. Use create_card with a column_id to add cards."
    return json.dumps(result, indent=2, default=str)


# A canonical UUID is 36 chars (8-4-4-4-12 with hyphens). Anything shorter is
# treated as a prefix and sent to the board-scoped resolve endpoint, so callers
# can look a card up by the short id fragment they see in notes/standups/briefs.
_FULL_UUID_LEN = 36


async def _resolve_card_id(client, slug: str, board_id: str, card_id: str) -> str:
    """Expand a short id fragment to the full UUID the strict routes require.

    The backend `/{card_id}` routes declare `card_id: uuid.UUID` and 422 a
    prefix before any handler runs (a deliberate decision — resolution belongs
    at this layer). A full-length id is returned untouched so the common case
    costs no extra round-trip; an ambiguous prefix raises out of the resolve
    call, letting the backend's candidate-listing 409 reach the caller verbatim.
    """
    if len(card_id) >= _FULL_UUID_LEN:
        return card_id
    resolved = await client.get(
        f"{_cards_path(slug, board_id)}/resolve?prefix={card_id}"
    )
    return resolved["id"]


@mcp.tool()
@handle_api_errors
async def get_card(workspace_slug: str, board_id: str, card_id: str, ctx: Context) -> str:
    """Get one card with full details (participants, markdown description).

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    if len(card_id) < _FULL_UUID_LEN:
        # The resolve endpoint already returns the full CardRead — no second hop.
        path = f"{_cards_path(workspace_slug, board_id)}/resolve?prefix={card_id}"
    else:
        # format=markdown: descriptions are stored as canonical PM JSON
        # (editor P0-3); LLM callers read faithful markdown, not the JSON ballast.
        path = f"{_cards_path(workspace_slug, board_id)}/{card_id}?format=markdown"
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_card(
    workspace_slug: str,
    board_id: str,
    column_id: str,
    title: str,
    description: str = "",
    card_type: str = "task",
    priority: str = "none",
    due_date: str | None = None,
    status: str | None = None,
    labels: list[str] | None = None,
    git_repo_slug: str | None = None,
    ctx: Context = None,
) -> str:
    """Create a card in a column.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        column_id: Target column UUID.
        title: Max 500 characters.
        description: Card description.
        card_type: task|issue|feature|bug.
        priority: none|low|medium|high|urgent.
        due_date: YYYY-MM-DD.
        status: Short state label. Max 255 characters.
        labels: Label strings.
        git_repo_slug: Target repo slug on multi-repo boards; omit for the primary repo.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body: dict = {
        "title": title,
        "description": description,
        "card_type": card_type,
        "priority": priority,
        "column_id": column_id,
    }
    if due_date is not None:
        body["due_date"] = due_date
    if status is not None:
        body["status"] = status
    if labels is not None:
        body["labels"] = labels
    if git_repo_slug is not None:
        body["git_repo_slug"] = git_repo_slug
    result = await client.post(_cards_path(workspace_slug, board_id), body)
    return _card_receipt(result)


ClearableCardField = Literal[
    "due_date",
    "status",
    "labels",
    "pr_url",
    "branch_name",
    "git_repo_slug",
]


@mcp.tool()
@handle_api_errors
async def update_card(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    title: str | None = None,
    description: str | None = None,
    card_type: str | None = None,
    priority: str | None = None,
    due_date: str | None = None,
    status: str | None = None,
    labels: list[str] | None = None,
    pr_url: str | None = None,
    branch_name: str | None = None,
    git_repo_slug: str | None = None,
    clear_fields: list[ClearableCardField] | None = None,
    ctx: Context = None,
) -> str:
    """Update card fields; omitted or null values keep existing values.

    To clear nullable values, pass clear_fields=["due_date"] (or another
    supported field). Do not also set a non-null value for a cleared field.
    Clear a description with description=""; clear labels with labels=[] or
    clear_fields=["labels"] (JSON null). Repeating a clear is safe.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
        title: Max 500 characters.
        description: New description.
        card_type: task|issue|feature|bug.
        priority: none|low|medium|high|urgent.
        due_date: YYYY-MM-DD.
        status: Short state label. Max 255 characters.
        labels: Replaces the whole label list.
        pr_url: PR the card shipped as; prefer it over a link in the description.
        branch_name: Branch the work landed on.
        git_repo_slug: Target repo slug on multi-repo boards.
        clear_fields: Nullable fields to set to null: due_date, status, labels,
            pr_url, branch_name, git_repo_slug. Omit to preserve existing values.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body = {
        k: v
        for k, v in {
            "title": title,
            "description": description,
            "card_type": card_type,
            "priority": priority,
            "due_date": due_date,
            "status": status,
            "labels": labels,
            "pr_url": pr_url,
            "branch_name": branch_name,
            "git_repo_slug": git_repo_slug,
        }.items()
        if v is not None
    }
    clearing = set(clear_fields or [])
    invalid = clearing - set(get_args(ClearableCardField))
    conflicting = clearing & body.keys()
    if invalid or conflicting:
        message = (
            f"Cannot clear unsupported fields: {', '.join(sorted(invalid))}."
            if invalid
            else f"Cannot both set and clear fields: {', '.join(sorted(conflicting))}."
        )
        return json.dumps(
            {
                "error": True,
                "status": 422,
                "message": message,
                "_hint": "Use clear_fields only for nullable fields without non-null values.",
            }
        )
    body.update(dict.fromkeys(clearing))
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    path = f"{_cards_path(workspace_slug, board_id)}/{resolved_id}"
    result = await client.patch(path, body)
    return _card_receipt(result)


@mcp.tool()
@handle_api_errors
async def delete_card(workspace_slug: str, board_id: str, card_id: str, ctx: Context) -> str:
    """Delete a card permanently.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    path = f"{_cards_path(workspace_slug, board_id)}/{resolved_id}"
    await client.delete(path)
    return f"Card {resolved_id} deleted successfully"


@mcp.tool()
@handle_api_errors
async def move_card(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    column_id: str,
    position: float | None = None,
    ctx: Context = None,
) -> str:
    """Move a card to another column and/or position. Omit position to append to the end of the target column.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
        column_id: Target column UUID.
        position: Fractional index (midpoint between neighbours); omitted appends.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    path = f"{_cards_path(workspace_slug, board_id)}/{resolved_id}/move"
    body: dict = {"column_id": column_id}
    if position is not None:
        body["position"] = position
    result = await client.patch(path, body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def add_card_participant(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    user_id: str,
    role: str = "hero",
    pipeline_role: str | None = None,
    ctx: Context = None,
) -> str:
    """Add a participant to a card. Idempotent: an existing row keeps its pipeline_role unless it was NULL, which is backfilled.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
        user_id: User UUID.
        role: hero (responsible)|viewer|stakeholder|helper.
        pipeline_role: Stage role for role-aware filters (planner, implementer, reviewer, ... or custom; max 64 chars).
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    path = f"{_cards_path(workspace_slug, board_id)}/{resolved_id}/participants"
    body: dict = {"user_id": user_id, "role": role}
    if pipeline_role:
        body["pipeline_role"] = pipeline_role
    result = await client.post(path, body)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def remove_card_participant(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    user_id: str | None = None,
    pipeline_role: str | None = None,
    ctx: Context = None,
) -> str:
    """Remove participants from a card: one person by user_id, or every holder of a pipeline_role (e.g. drop the stale implementer before rework; idempotent — a no-op when nobody holds it). Exactly one selector.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID or id prefix.
        user_id: Participant's user UUID (one person).
        pipeline_role: Stage role to clear — planner, implementer, reviewer, rework_mediator or custom; instead of user_id.
    """
    if bool(user_id) == bool(pipeline_role):
        return json.dumps(
            {"error": True, "message": "pass exactly one of user_id or pipeline_role"}, indent=2
        )
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    resolved_id = await _resolve_card_id(client, workspace_slug, board_id, card_id)
    if pipeline_role:
        await client.delete(
            f"{_cards_path(workspace_slug, board_id)}/{resolved_id}/participants/by-pipeline-role/{pipeline_role}"
        )
        return f"Removed all '{pipeline_role}' participants from card {resolved_id}"
    await client.delete(f"{_cards_path(workspace_slug, board_id)}/{resolved_id}/participants/{user_id}")
    return f"Participant {user_id} removed from card {resolved_id}"


@deprecated_tool()
@handle_api_errors
async def remove_card_participants_by_role(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    pipeline_role: str,
    ctx: Context = None,
) -> str:
    """Remove every participant holding a pipeline_role. Idempotent.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID.
        pipeline_role: Stage role to clear.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_cards_path(workspace_slug, board_id)}/{card_id}/participants/by-pipeline-role/{pipeline_role}"
    await client.delete(path)
    return f"Removed all '{pipeline_role}' participants from card {card_id}"


@deprecated_tool()
@handle_api_errors
async def claim_card(
    workspace_slug: str,
    board_id: str,
    card_id: str,
    agent_id: str,
    ctx: Context = None,
) -> str:
    """Make a runner the hero of one card and move it to In Progress; 409 if already claimed.

    Args:
        workspace_slug: Workspace slug.
        board_id: Board UUID.
        card_id: Card UUID.
        agent_id: Claiming runner's UUID.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_cards_path(workspace_slug, board_id)}/{card_id}/claim"
    result = await client.post(path, {"agent_id": agent_id})
    result["_hint"] = "Card claimed: the runner is the hero and the card sits in In Progress."
    return json.dumps(result, indent=2, default=str)
