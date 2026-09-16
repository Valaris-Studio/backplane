# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board detail GET `?summary=true` — the cheap kanban payload.

The default (summary omitted / false) path must stay byte-identical: MCP
get_board, the runner, and every existing client read it.
"""
import json

from httpx import AsyncClient

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User

BASE_URL = "/api/workspaces/default/boards"


def _prosemirror(*paragraphs: str) -> str:
    return json.dumps(
        {
            "type": "doc",
            "content": [
                {
                    "type": "paragraph",
                    "content": [{"type": "text", "text": text}],
                }
                for text in paragraphs
            ],
        }
    )


async def _seed_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    description: str,
    *,
    title: str = "Payload Card",
    position: float = 1024.0,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description=description,
        position=position,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


def _cards_of(board_payload: dict) -> list[dict]:
    return [card for column in board_payload["columns"] for card in column["cards"]]


async def test_summary_replaces_description_with_plain_text_excerpt(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    body = _prosemirror("The quick brown fox", "jumps over the lazy dog")
    await _seed_card(db_session, test_board, test_column, test_user, body)

    response = await client.get(f"{BASE_URL}/{test_board.id}", params={"summary": True})

    assert response.status_code == 200
    card = _cards_of(response.json())[0]
    # The board renders a plain-text excerpt on the card face and searches it;
    # the multi-kilobyte ProseMirror body is what must not travel.
    assert card["description"] == "The quick brown fox jumps over the lazy dog"


async def test_default_call_still_returns_the_full_description_body(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    body = _prosemirror("The quick brown fox")
    await _seed_card(db_session, test_board, test_column, test_user, body)

    response = await client.get(f"{BASE_URL}/{test_board.id}")

    assert response.status_code == 200
    assert _cards_of(response.json())[0]["description"] == body


async def test_summary_excerpt_is_truncated(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    await _seed_card(db_session, test_board, test_column, test_user, _prosemirror("x" * 9000))

    response = await client.get(f"{BASE_URL}/{test_board.id}", params={"summary": True})

    excerpt = _cards_of(response.json())[0]["description"]
    # Bounded, but at the client search window (5000) rather than the card
    # face's 200 — the face re-truncates for display, search cannot re-fetch.
    assert len(excerpt) < 5100
    assert excerpt.endswith("...")


async def test_summary_preserves_every_other_board_rendered_field(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    created = await _seed_card(db_session, test_board, test_column, test_user, _prosemirror("body"))

    summary_card = _cards_of(
        (
            await client.get(f"{BASE_URL}/{test_board.id}", params={"summary": True})
        ).json()
    )[0]
    full_card = _cards_of((await client.get(f"{BASE_URL}/{test_board.id}")).json())[0]

    assert summary_card["id"] == str(created.id)
    # Description is the ONLY field summary mode is allowed to change.
    assert {k: v for k, v in summary_card.items() if k != "description"} == {
        k: v for k, v in full_card.items() if k != "description"
    }


async def test_summary_read_does_not_truncate_the_stored_description(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """The request session auto-commits, so excerpting must never touch the ORM.

    Trimming `card.description` on the loaded instance would flush the excerpt
    back and destroy every card body on the board — a read silently eating data.
    """
    body = _prosemirror("x" * 5000)
    card = await _seed_card(db_session, test_board, test_column, test_user, body)

    await client.get(f"{BASE_URL}/{test_board.id}", params={"summary": True})

    stored = (await client.get(f"{BASE_URL}/{test_board.id}/cards/{card.id}")).json()
    assert stored["description"] == body


async def test_summary_handles_empty_and_legacy_html_descriptions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    seeds = (("Empty", ""), ("Legacy", "<p>plain <b>html</b></p>"))
    for offset, (title, description) in enumerate(seeds):
        await _seed_card(
            db_session,
            test_board,
            test_column,
            test_user,
            description,
            title=title,
            position=1024.0 * (offset + 1),
        )

    cards = _cards_of(
        (
            await client.get(f"{BASE_URL}/{test_board.id}", params={"summary": True})
        ).json()
    )
    by_title = {card["title"]: card["description"] for card in cards}

    assert by_title["Empty"] == ""
    # Legacy HTML must degrade to stripped text, never travel as raw markup.
    assert by_title["Legacy"] == "plain html"


async def test_summary_excerpt_carries_the_full_client_search_window(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """The board's client-side search reads 5000 chars of this text.

    Truncating to the ~200 chars the card FACE shows made every card body past
    that point unsearchable, because the frontend only ever fetches summary
    mode. The face re-truncates client-side, so the payload is free to be long.
    """
    needle = "quokka"
    body = _prosemirror("x" * 3000 + f" {needle} " + "y" * 500)

    await _seed_card(db_session, test_board, test_column, test_user, body)

    response = await client.get(f"{BASE_URL}/{test_board.id}", params={"summary": True})

    assert needle in _cards_of(response.json())[0]["description"]
