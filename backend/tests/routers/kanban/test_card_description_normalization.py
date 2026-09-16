# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card descriptions get the notes normalization contract (editor P0-3).

Notes normalize `content` to canonical ProseMirror JSON at write time
(schemas/notes/note.py `_normalize` → `normalize_note_content`); card
descriptions are still stored as the raw string the API received. These
tests pin the same normalize-on-write contract for CardCreate/CardUpdate
plus the `?format=markdown` read path mirroring the notes router's
NoteFormat param (routers/notes/workspace_notes.py).

Empty stays empty: "" is stored/returned as "" — never inflated to an
empty-doc JSON blob — so boards full of description-less cards carry no
PM ballast and `if card.description` checks keep working.
"""
import json
import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"

MD_DESC = "# Goal\n\n- item"

TABLE_MD_DESC = "# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 |"

PLAIN_TEXT_DESC = "just words"

CANONICAL_DOC = {
    "type": "doc",
    "content": [
        {
            "type": "paragraph",
            "content": [{"type": "text", "text": "already canonical"}],
        }
    ],
}


def _url(board: Board, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/cards{suffix}"


async def _create_card(
    client: AsyncClient, board: Board, column: Column, description
) -> dict:
    body = {"title": "Normalized", "column_id": str(column.id)}
    if description is not None:
        body["description"] = description
    response = await client.post(_url(board), json=body)
    assert response.status_code == 201
    return response.json()


async def _stored_description(db: AsyncSession, card_id: str) -> str:
    card = await db.get(Card, uuid.UUID(card_id))
    return card.description


# --- Write normalization: create ---------------------------------------------


async def test_create_card_markdown_description_stored_as_pm_json(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    data = await _create_card(client, test_board, test_column, MD_DESC)

    stored = await _stored_description(db_session, data["id"])
    doc = json.loads(stored)
    assert doc["type"] == "doc"
    assert doc["content"][0]["type"] == "heading"
    assert doc["content"][1]["type"] == "bulletList"


async def test_create_card_markdown_table_description_yields_table_node(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    """A GFM table markdown description becomes a real PM table node — the
    P0-1 normalizer handles tables; storing the pipes as flat text would
    resurrect the silent table-destruction bug at the card layer."""
    data = await _create_card(client, test_board, test_column, TABLE_MD_DESC)

    stored = await _stored_description(db_session, data["id"])
    doc = json.loads(stored)
    assert doc["type"] == "doc"
    table = next(n for n in doc["content"] if n["type"] == "table")
    header_cells = table["content"][0]["content"]
    assert header_cells[0]["type"] == "tableHeader"
    assert header_cells[0]["content"][0]["content"][0]["text"] == "A"


async def test_create_card_pm_json_description_stored_canonical(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    """An already-canonical PM JSON string round-trips structurally unchanged
    (re-serialization is fine — mirrors what the notes suite pins)."""
    data = await _create_card(
        client, test_board, test_column, json.dumps(CANONICAL_DOC)
    )

    stored = await _stored_description(db_session, data["id"])
    assert json.loads(stored) == CANONICAL_DOC


async def test_create_card_plain_text_description_wrapped_in_paragraph(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    data = await _create_card(client, test_board, test_column, PLAIN_TEXT_DESC)

    stored = await _stored_description(db_session, data["id"])
    doc = json.loads(stored)
    assert doc["type"] == "doc"
    assert doc["content"][0]["type"] == "paragraph"
    assert doc["content"][0]["content"][0]["text"] == PLAIN_TEXT_DESC


async def test_create_card_empty_description_stays_empty_string(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    """Empty NEVER becomes an empty-doc JSON blob — omitted and explicit ""
    both store and return exactly ""."""
    omitted = await _create_card(client, test_board, test_column, None)
    assert omitted["description"] == ""
    assert await _stored_description(db_session, omitted["id"]) == ""

    explicit = await _create_card(client, test_board, test_column, "")
    assert explicit["description"] == ""
    assert await _stored_description(db_session, explicit["id"]) == ""


# --- Write normalization: update ----------------------------------------------


async def test_update_card_markdown_description_stored_as_pm_json(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"description": MD_DESC},
    )
    assert response.status_code == 200

    await db_session.refresh(test_card)
    doc = json.loads(test_card.description)
    assert doc["type"] == "doc"
    assert doc["content"][0]["type"] == "heading"
    assert doc["content"][1]["type"] == "bulletList"


async def test_update_card_description_none_leaves_field_untouched(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    """description=null is "no change", never "clear" — clearing is spelled ""."""
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"description": None},
    )
    assert response.status_code == 200
    assert response.json()["description"] == "A test card"

    await db_session.refresh(test_card)
    assert test_card.description == "A test card"


async def test_update_card_description_empty_string_clears_to_empty(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.patch(
        _url(test_board, f"/{test_card.id}"),
        json={"description": ""},
    )
    assert response.status_code == 200
    assert response.json()["description"] == ""

    await db_session.refresh(test_card)
    assert test_card.description == ""


# --- Read: ?format=markdown (mirrors the notes NoteFormat param) --------------


async def test_get_card_format_markdown_returns_faithful_markdown(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    data = await _create_card(client, test_board, test_column, TABLE_MD_DESC)
    card_id = data["id"]

    # Default GET (no param) returns the stored canonical PM JSON.
    default = await client.get(_url(test_board, f"/{card_id}"))
    assert default.status_code == 200
    assert json.loads(default.json()["description"])["type"] == "doc"

    # ?format=markdown serializes it back to faithful markdown.
    markdown = await client.get(_url(test_board, f"/{card_id}?format=markdown"))
    assert markdown.status_code == 200
    description = markdown.json()["description"]
    assert "# Title" in description
    assert "| A | B |" in description
    assert '"type"' not in description


async def test_get_card_invalid_format_rejected(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.get(_url(test_board, f"/{test_card.id}?format=html"))
    assert response.status_code == 422
