# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

from mcp.server.fastmcp import Context

from valaris_mcp.deprecation import deprecated_tool
from valaris_mcp.errors import handle_api_errors
from valaris_mcp.server import AppContext, mcp

# A canonical UUID is 36 chars; anything shorter is treated as a prefix and
# resolved through the scope's /resolve endpoint (mirrors tools/cards.py).
_FULL_UUID_LEN = 36


def _notes_path(client, slug: str, board_id: str | None) -> str:
    if board_id:
        return f"{client.board(slug, board_id)}/notes"
    return f"{client.ws(slug)}/notes"


def _note_receipt(result) -> str:
    if isinstance(result, dict) and "content" in result:
        result = {
            **result,
            "_content_format": "prosemirror",
            "_hint": (
                'content is ProseMirror JSON, not markdown. Preserve your original markdown '
                'or use get_note(format="markdown") before editing; prefer update_note '
                'mode="append" or "section" for partial edits.'
            ),
        }
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def list_notes(
    workspace_slug: str,
    board_id: str | None = None,
    card_id: str | None = None,
    summary_only: bool = True,
    q: str | None = None,
    pinned_only: bool = False,
    kinds: list[str] | None = None,
    limit: int = 25,
    offset: int = 0,
    ctx: Context = None,
) -> str:
    """Browse a bounded page of notes; returns notes, total, has_more and next_offset.

    Args:
        workspace_slug: Workspace slug (without board_id, workspace-level notes only).
        board_id: Board UUID if board-scoped.
        card_id: Only notes linked to this card on this board (needs board_id).
        summary_only: Omit bodies by default; use get_note(format="markdown") to read one.
        q: Case-insensitive substring search in title and plain-text body, before paging.
        pinned_only: Only pinned notes.
        kinds: Match any listed note kind (e.g. plan, review_verdict).
        limit: Page size, 1–100; default 25.
        offset: Zero-based offset; follow next_offset with the same filters.
    """
    if not 1 <= limit <= 100 or offset < 0:
        return _note_error("limit must be 1–100 and offset must be non-negative")
    if card_id and not board_id:
        return _note_error("card_id requires board_id")
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    params: dict = {"summary_only": str(summary_only).lower(), "limit": limit, "offset": offset}
    if card_id:
        params["card_id"] = card_id
    if q:
        params["q"] = q
    if pinned_only:
        params["pinned_only"] = "true"
    if kinds:
        params["kinds"] = kinds
    response = await client.request_raw(
        "GET", _notes_path(client, workspace_slug, board_id), params=params
    )
    notes = response.json()
    try:
        total = int(response.headers["X-Total-Count"])
    except (KeyError, ValueError):
        return _note_error("Backend did not provide pagination metadata; upgrade the backend before browsing notes.")
    if not isinstance(notes, list) or len(notes) > limit or total < 0:
        return _note_error("Backend returned invalid pagination data; no complete inventory can be inferred.")
    next_offset = offset + len(notes)
    if notes and next_offset > total:
        return _note_error("Note inventory changed during pagination; restart from offset=0.")
    has_more = next_offset < total
    if has_more and not notes:
        return _note_error("Note inventory changed during pagination; restart from offset=0.")
    return json.dumps(
        {
            "notes": notes,
            "total": total,
            "limit": limit,
            "offset": offset,
            "has_more": has_more,
            "next_offset": next_offset if has_more else None,
            "_hint": (
                'Follow next_offset with the same filters. Pages are a live view; '
                'restart if notes change. Use get_note(format="markdown") for a readable body.'
            ),
        },
        indent=2,
        default=str,
    )


@mcp.tool()
@handle_api_errors
async def get_note(
    workspace_slug: str,
    note_id: str,
    board_id: str | None = None,
    format: str = "prosemirror",
    ctx: Context = None,
) -> str:
    """Read one note; format="markdown" returns readable, token-cheap content.

    Args:
        workspace_slug: Workspace slug.
        note_id: Note UUID or id prefix (resolved within the same scope).
        board_id: Board UUID if board-scoped.
        format: prosemirror (default, raw JSON) or markdown.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    base = _notes_path(client, workspace_slug, board_id)
    if len(note_id) < _FULL_UUID_LEN:
        resolved = await client.get(f"{base}/resolve?prefix={note_id}")
        note_id = resolved["id"]
    path = f"{base}/{note_id}"
    if format and format != "prosemirror":
        path = f"{path}?format={format}"
    result = await client.get(path)
    return json.dumps(result, indent=2, default=str)


@mcp.tool()
@handle_api_errors
async def create_note(
    workspace_slug: str,
    title: str,
    content: str = "",
    pinned: bool = False,
    board_id: str | None = None,
    card_id: str | None = None,
    kind: str = "user_note",
    ctx: Context = None,
) -> str:
    """Create a note in a workspace or board, optionally linked to a card.

    Args:
        workspace_slug: Workspace slug.
        title: Note title.
        content: Body as markdown (HTML, plain text or ProseMirror JSON also accepted).
        pinned: Pin the note to the top.
        board_id: Board UUID if board-scoped.
        card_id: Card to link; needs board_id and a card on this board (else 422; unknown or cross-workspace card 404).
        kind: user_note (default) or a structural kind: plan, rework_brief,
            review_verdict, ...
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    # `kind` is always on the wire — even when default — so the contract is
    # explicit at the boundary and silent drift to user_note can't happen.
    body = {"title": title, "content": content, "pinned": pinned, "kind": kind}
    if card_id:
        body["card_id"] = card_id
    result = await client.post(_notes_path(client, workspace_slug, board_id), body)
    return _note_receipt(result)


NOTE_WRITE_MODES = ("replace", "append", "section")


def _note_error(message: str) -> str:
    return json.dumps({"error": True, "message": message}, indent=2)


async def _put_note_fields(client, workspace_slug, board_id, note_id, title, pinned, card_id, detach_card, content):
    body: dict = {}
    if title is not None:
        body["title"] = title
    if content is not None:
        body["content"] = content
    if pinned is not None:
        body["pinned"] = pinned
    if detach_card:
        body["card_id"] = None
    elif card_id is not None:
        body["card_id"] = card_id
    if not body:
        return None
    path = f"{_notes_path(client, workspace_slug, board_id)}/{note_id}"
    return await client.put(path, body)


async def _append_note_blocks(client, workspace_slug, board_id, note_id, content):
    path = f"{_notes_path(client, workspace_slug, board_id)}/{note_id}/append"
    return await client.post(path, {"content": content})


async def _replace_note_section(client, workspace_slug, board_id, note_id, anchor_heading, content):
    path = f"{_notes_path(client, workspace_slug, board_id)}/{note_id}/replace-section"
    return await client.post(path, {"anchor_heading": anchor_heading, "content": content})


@mcp.tool()
@handle_api_errors
async def update_note(
    workspace_slug: str,
    note_id: str,
    title: str | None = None,
    content: str | None = None,
    mode: str = "replace",
    anchor_heading: str | None = None,
    pinned: bool | None = None,
    board_id: str | None = None,
    card_id: str | None = None,
    detach_card: bool = False,
    ctx: Context = None,
) -> str:
    """Update a note; only provided fields change. mode decides what content does to the body: "replace" (default) rewrites the whole body; "append" adds blocks at the end (additive — a retry appends twice); "section" rewrites the body under anchor_heading only (idempotent; the heading stays, empty content clears the section, a missing heading is 404 and a duplicate 409). Prefer append/section for logs, trackers and long pinned notes. title/pinned/card_id apply in every mode.

    Args:
        workspace_slug: Workspace slug.
        note_id: Note UUID.
        title: New title.
        content: Body as markdown (HTML, plain text or ProseMirror JSON also accepted); required for mode="append".
        mode: "replace" (whole body), "append" (blocks at the end), or "section" (under anchor_heading).
        anchor_heading: mode="section" only: heading text without the leading # marks (trimmed, case-insensitive).
        pinned: Pin state.
        board_id: Board UUID if board-scoped.
        card_id: Card to link (must be on the note's board); omit to keep the current link.
        detach_card: Clear the card link; wins over card_id.
    """
    if mode not in NOTE_WRITE_MODES:
        return _note_error(f"mode must be one of {', '.join(NOTE_WRITE_MODES)}; got {mode!r}")
    if mode == "append" and not (content and content.strip()):
        return _note_error('mode="append" needs non-empty content')
    if mode == "section" and not (anchor_heading and anchor_heading.strip()):
        return _note_error('mode="section" needs anchor_heading')
    if mode != "section" and anchor_heading is not None:
        return _note_error('anchor_heading only applies to mode="section"')

    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    body_content = content if mode == "replace" else None
    result = await _put_note_fields(
        client, workspace_slug, board_id, note_id, title, pinned, card_id, detach_card, body_content
    )
    if mode == "append":
        result = await _append_note_blocks(client, workspace_slug, board_id, note_id, content)
    elif mode == "section":
        result = await _replace_note_section(
            client, workspace_slug, board_id, note_id, anchor_heading, content or ""
        )
    return _note_receipt(result)


@deprecated_tool()
@handle_api_errors
async def append_note(
    workspace_slug: str,
    note_id: str,
    content: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Append blocks to the end of a note. Not idempotent: a retry appends again.

    Args:
        workspace_slug: Workspace slug.
        note_id: Note UUID.
        content: Blocks to append (markdown recommended).
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _append_note_blocks(app.client, workspace_slug, board_id, note_id, content)
    return _note_receipt(result)


@deprecated_tool()
@handle_api_errors
async def replace_note_section(
    workspace_slug: str,
    note_id: str,
    anchor_heading: str,
    content: str = "",
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Rewrite the body under one heading of a note, leaving the rest untouched. Idempotent.

    Args:
        workspace_slug: Workspace slug.
        note_id: Note UUID.
        anchor_heading: Heading text without the leading # marks.
        content: New section body (markdown recommended); empty clears it.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    result = await _replace_note_section(
        app.client, workspace_slug, board_id, note_id, anchor_heading, content
    )
    return _note_receipt(result)


@mcp.tool()
@handle_api_errors
async def delete_note(
    workspace_slug: str,
    note_id: str,
    board_id: str | None = None,
    ctx: Context = None,
) -> str:
    """Delete a note permanently.

    Args:
        workspace_slug: Workspace slug.
        note_id: Note UUID.
        board_id: Board UUID if board-scoped.
    """
    app: AppContext = ctx.request_context.lifespan_context
    client = app.client
    path = f"{_notes_path(client, workspace_slug, board_id)}/{note_id}"
    await client.delete(path)
    return f"Note {note_id} deleted."
