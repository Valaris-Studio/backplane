# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Notes <-> cards link/unlink contract (card cb54eb39).

Pins the full card_id lifecycle on notes:
- link / re-link / change / explicit-null clear / omit-preserves via PUT
- validation: nonexistent + cross-workspace card -> 404 (anti-enumeration:
  cross-workspace behaves identically to nonexistent), cross-board card -> 422,
  workspace-level note linking any card -> 422 (applies to create AND update).
"""

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


BOARD_NOTES_URL = "/api/workspaces/default/boards/{board_id}/notes"
WS_NOTES_URL = "/api/workspaces/default/notes"


async def _create_board_note(client: AsyncClient, board_id, **extra) -> dict:
    url = BOARD_NOTES_URL.format(board_id=board_id)
    payload = {"title": "Link target note", **extra}
    resp = await client.post(url, json=payload)
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _make_card_on(
    db_session: AsyncSession, board: Board, user: User, title: str = "Other Card"
) -> Card:
    column = Column(board_id=board.id, name="Col", position=1024.0, color="#6b7280")
    db_session.add(column)
    await db_session.flush()
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=1024.0,
        created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()
    return card


# --- update: happy path -------------------------------------------------------


async def test_update_note_links_card_success(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id)
    assert note["card_id"] is None

    response = await client.put(
        f"{url}/{note['id']}", json={"card_id": str(test_card.id)}
    )
    assert response.status_code == 200, response.text
    assert response.json()["card_id"] == str(test_card.id)

    # Re-read proves the link persisted, not just echoed.
    reread = await client.get(f"{url}/{note['id']}")
    assert reread.status_code == 200
    assert reread.json()["card_id"] == str(test_card.id)


async def test_update_note_relink_same_card_idempotent(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id, card_id=str(test_card.id))
    assert note["card_id"] == str(test_card.id)

    response = await client.put(
        f"{url}/{note['id']}", json={"card_id": str(test_card.id)}
    )
    assert response.status_code == 200, response.text
    assert response.json()["card_id"] == str(test_card.id)


async def test_update_note_change_linked_card(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    card_b = await _make_card_on(db_session, test_board, test_user, title="Card B")

    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id, card_id=str(test_card.id))

    response = await client.put(f"{url}/{note['id']}", json={"card_id": str(card_b.id)})
    assert response.status_code == 200, response.text
    assert response.json()["card_id"] == str(card_b.id)

    reread = await client.get(f"{url}/{note['id']}")
    assert reread.json()["card_id"] == str(card_b.id)


async def test_update_note_clear_card_id_with_explicit_null(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id, card_id=str(test_card.id))
    assert note["card_id"] == str(test_card.id)

    response = await client.put(f"{url}/{note['id']}", json={"card_id": None})
    assert response.status_code == 200, response.text
    assert response.json()["card_id"] is None

    reread = await client.get(f"{url}/{note['id']}")
    assert reread.json()["card_id"] is None


async def test_update_note_omitting_card_id_preserves_link(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id, card_id=str(test_card.id))

    response = await client.put(f"{url}/{note['id']}", json={"title": "Renamed"})
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["title"] == "Renamed"
    assert data["card_id"] == str(test_card.id)


# --- update: validation -------------------------------------------------------


async def test_update_note_nonexistent_card_404(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id)

    response = await client.put(
        f"{url}/{note['id']}", json={"card_id": str(uuid.uuid4())}
    )
    assert response.status_code == 404, response.text

    # The failed link must not have been persisted.
    reread = await client.get(f"{url}/{note['id']}")
    assert reread.json()["card_id"] is None


async def test_update_note_cross_workspace_card_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    # A real card, but in a different workspace: must be indistinguishable
    # from a nonexistent card (anti-enumeration).
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    other_board = Board(
        workspace_id=other_ws.id,
        name="Other Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    foreign_card = await _make_card_on(db_session, other_board, test_user)

    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id)

    response = await client.put(
        f"{url}/{note['id']}", json={"card_id": str(foreign_card.id)}
    )
    assert response.status_code == 404, response.text


async def test_update_note_cross_board_card_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    # Card exists in the same workspace but on a different board than the note.
    sibling_board = Board(
        workspace_id=test_workspace.id,
        name="Sibling Board",
        slug="sibling-board",
        created_by=test_user.id,
    )
    db_session.add(sibling_board)
    await db_session.flush()
    sibling_card = await _make_card_on(db_session, sibling_board, test_user)

    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id)

    response = await client.put(
        f"{url}/{note['id']}", json={"card_id": str(sibling_card.id)}
    )
    assert response.status_code == 422, response.text

    reread = await client.get(f"{url}/{note['id']}")
    assert reread.json()["card_id"] is None


async def test_update_note_workspace_level_note_link_422(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    # A workspace-level note (board_id=None) has no effective board, so
    # linking ANY card is invalid.
    create_resp = await client.post(WS_NOTES_URL, json={"title": "Workspace note"})
    assert create_resp.status_code == 201, create_resp.text
    note_id = create_resp.json()["id"]

    response = await client.put(
        f"{WS_NOTES_URL}/{note_id}", json={"card_id": str(test_card.id)}
    )
    assert response.status_code == 422, response.text

    reread = await client.get(f"{WS_NOTES_URL}/{note_id}")
    assert reread.json()["card_id"] is None


# --- create: validation -------------------------------------------------------


async def test_create_note_nonexistent_card_404(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    response = await client.post(
        url, json={"title": "Bad link", "card_id": str(uuid.uuid4())}
    )
    assert response.status_code == 404, response.text


async def test_create_note_cross_board_card_422(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    sibling_board = Board(
        workspace_id=test_workspace.id,
        name="Sibling Board",
        slug="sibling-board",
        created_by=test_user.id,
    )
    db_session.add(sibling_board)
    await db_session.flush()
    sibling_card = await _make_card_on(db_session, sibling_board, test_user)

    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    response = await client.post(
        url, json={"title": "Wrong board", "card_id": str(sibling_card.id)}
    )
    assert response.status_code == 422, response.text


async def test_create_note_cross_workspace_card_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    # Create-side twin of the update guard: a real card in another workspace
    # must be indistinguishable from a nonexistent one (anti-enumeration).
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    other_board = Board(
        workspace_id=other_ws.id,
        name="Other Board",
        slug="other-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    foreign_card = await _make_card_on(db_session, other_board, test_user)

    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    response = await client.post(
        url, json={"title": "Cross-ws link", "card_id": str(foreign_card.id)}
    )
    assert response.status_code == 404, response.text


# --- update: immutable kinds --------------------------------------------------


async def test_link_immutable_note_403(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    # The IMMUTABLE_KINDS gate fires before the card_id branch: a
    # review_verdict note can never be linked after creation. The card-side UI
    # must therefore not offer link/unlink for these kinds.
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id, kind="review_verdict")

    response = await client.put(
        f"{url}/{note['id']}", json={"card_id": str(test_card.id)}
    )
    assert response.status_code == 403, response.text

    reread = await client.get(f"{url}/{note['id']}")
    assert reread.json()["card_id"] is None


async def test_unlink_immutable_note_403(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    # Creation MAY set card_id on a review_verdict note (that's how verdicts
    # attach to their card); once created, even clearing the link is a
    # forbidden mutation.
    url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(
        client, test_board.id, kind="review_verdict", card_id=str(test_card.id)
    )
    assert note["card_id"] == str(test_card.id)

    response = await client.put(f"{url}/{note['id']}", json={"card_id": None})
    assert response.status_code == 403, response.text

    reread = await client.get(f"{url}/{note['id']}")
    assert reread.json()["card_id"] == str(test_card.id)


# --- update: workspace router on a board-scoped note --------------------------


async def test_workspace_route_links_board_note(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
):
    # The MCP path when board_id is omitted: the workspace router passes no
    # board_id, so link validation must fall back to the NOTE's own board.
    board_url = BOARD_NOTES_URL.format(board_id=test_board.id)
    note = await _create_board_note(client, test_board.id)

    response = await client.put(
        f"{WS_NOTES_URL}/{note['id']}", json={"card_id": str(test_card.id)}
    )
    assert response.status_code == 200, response.text
    assert response.json()["card_id"] == str(test_card.id)

    reread = await client.get(f"{board_url}/{note['id']}")
    assert reread.json()["card_id"] == str(test_card.id)
