# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Card filters must compose with the board notes query, never bypass it."""

import datetime as dt
import uuid

import pytest

from app.models.kanban.board import Board
from app.models.workspace import Workspace

from .test_notes_query import WS_URL, board_url, make_note


async def test_card_notes_compose_filters_count_page_and_summary(
    client, db_session, test_workspace, test_board, test_card, test_user,
):
    for index, (title, pinned, kind, linked) in enumerate([
        ("match A", True, "user_note", True),
        ("match B", True, "user_note", True),
        ("match C", True, "user_note", True),
        ("match unpinned", False, "user_note", True),
        ("match wrong kind", True, "review_verdict", True),
        ("unrelated", True, "user_note", True),
        ("match unlinked", True, "user_note", False),
    ]):
        note = await make_note(
            db_session, test_workspace, title=title, body="sample body",
            created_by=test_user.id, board_id=test_board.id, pinned=pinned, kind=kind,
        )
        note.card_id = test_card.id if linked else None
        note.created_at = dt.datetime(2026, 1, index + 1)
    await db_session.flush()
    params = {
        "card_id": str(test_card.id), "q": "match", "pinned_only": "true",
        "kinds": "user_note", "authors": str(test_user.id), "order_by": "title",
        "direction": "asc", "limit": 1, "offset": 1, "summary_only": "true",
    }
    response = await client.get(board_url(test_board), params=params)
    assert response.status_code == 200
    assert response.headers.get("X-Total-Count") == "3"
    assert [row["title"] for row in response.json()] == ["match B"]
    assert "content" not in response.json()[0]
    assert response.json()[0]["preview"] == "sample body"
    params["offset"] = 10
    response = await client.get(board_url(test_board), params=params)
    assert response.json() == []
    assert response.headers["X-Total-Count"] == "3"


async def test_card_filter_cannot_escape_requested_board(
    client, db_session, test_workspace, test_board, test_card, test_user,
):
    note = await make_note(
        db_session, test_workspace, title="belongs elsewhere", created_by=test_user.id,
        board_id=test_board.id,
    )
    note.card_id = test_card.id
    other_board = Board(name="Other", slug="other-card-notes", workspace_id=test_workspace.id, created_by=test_user.id)
    db_session.add(other_board)
    await db_session.flush()
    for params in ({"card_id": str(test_card.id)}, {"card_id": str(test_card.id), "limit": 1}):
        response = await client.get(board_url(other_board), params=params)
        assert response.status_code == 200
        assert response.json() == []
        if "limit" in params:
            assert response.headers["X-Total-Count"] == "0"
        else:
            assert "X-Total-Count" not in response.headers


@pytest.mark.parametrize("board_scoped", [False, True])
async def test_legacy_paged_order_breaks_timestamp_ties_by_id(
    client, db_session, test_workspace, test_board, test_user, board_scoped,
):
    # Reverse insertion order ensures SQLite insertion order cannot fake the contract.
    ids = [uuid.UUID(int=index) for index in (3, 2, 1)]
    for note_id in ids:
        note = await make_note(
            db_session, test_workspace, title=str(note_id), created_by=test_user.id,
            board_id=test_board.id if board_scoped else None,
        )
        note.id = note_id
        note.created_at = dt.datetime(2026, 1, 1)
    await db_session.flush()
    url = board_url(test_board) if board_scoped else WS_URL
    actual = []
    for offset in range(3):
        response = await client.get(url, params={"limit": 1, "offset": offset})
        assert response.headers["X-Total-Count"] == "3"
        actual.append(response.json()[0]["id"])
    assert actual == [str(value) for value in sorted(ids)]


async def test_card_filter_does_not_bypass_workspace_authorization(
    client, db_session, test_card, test_user,
):
    workspace = Workspace(name="Private", slug="private-card-notes", created_by=test_user.id)
    db_session.add(workspace)
    await db_session.flush()
    board = Board(name="Private board", slug="private", workspace_id=workspace.id, created_by=test_user.id)
    db_session.add(board)
    await db_session.flush()
    response = await client.get(
        f"/api/workspaces/{workspace.slug}/boards/{board.id}/notes",
        params={"card_id": str(test_card.id), "limit": 1},
    )
    assert response.status_code == 403
