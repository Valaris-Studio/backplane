# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


BASE_URL = "/api/workspaces/default/notes"


async def test_list_workspace_notes_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_create_workspace_note(
    client: AsyncClient, test_workspace: Workspace
):
    import json

    response = await client.post(BASE_URL, json={"title": "WS Note", "content": "Content"})
    assert response.status_code == 201
    data = response.json()
    assert data["title"] == "WS Note"
    stored = json.loads(data["content"])
    assert stored["type"] == "doc"
    assert stored["content"][0]["content"][0]["text"] == "Content"
    assert data["board_id"] is None
    assert data["pinned"] is False


async def test_get_workspace_note(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"title": "Get This"})
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{note_id}")
    assert response.status_code == 200
    assert response.json()["title"] == "Get This"
    assert response.json()["id"] == note_id


async def test_update_workspace_note(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"title": "Original"})
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.put(f"{BASE_URL}/{note_id}", json={"title": "Updated", "pinned": True})
    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Updated"
    assert data["pinned"] is True


async def test_delete_workspace_note(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"title": "Delete Me"})
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.delete(f"{BASE_URL}/{note_id}")
    assert response.status_code == 204

    get_resp = await client.get(f"{BASE_URL}/{note_id}")
    assert get_resp.status_code == 404


async def test_get_workspace_note_not_found(
    client: AsyncClient, test_workspace: Workspace
):
    fake_id = uuid.uuid4()
    response = await client.get(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404


async def test_create_note_with_board_id_via_workspace_route_returns_board_scoped_note(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        BASE_URL,
        json={"title": "Board scoped", "board_id": str(test_board.id)},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["board_id"] == str(test_board.id)
    assert data["title"] == "Board scoped"


async def test_create_note_with_foreign_board_id_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Board that belongs to a *different* workspace must not be addressable
    # from the default workspace's notes route.
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_ws.id,
            user_id=test_user.id,
            role=WorkspaceRole.owner,
        )
    )
    foreign_board = Board(
        workspace_id=other_ws.id,
        name="Foreign",
        slug="foreign",
        created_by=test_user.id,
    )
    db_session.add(foreign_board)
    await db_session.flush()

    response = await client.post(
        BASE_URL,
        json={"title": "Cross tenant", "board_id": str(foreign_board.id)},
    )
    assert response.status_code == 404


async def test_create_note_without_board_id_still_workspace_scoped(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(BASE_URL, json={"title": "Plain WS note"})
    assert response.status_code == 201
    data = response.json()
    assert data["board_id"] is None
    assert data["title"] == "Plain WS note"


async def test_create_note_with_board_id_and_card_id_links_card_to_board_note(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_card
):
    response = await client.post(
        BASE_URL,
        json={
            "title": "Card + Board",
            "board_id": str(test_board.id),
            "card_id": str(test_card.id),
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["board_id"] == str(test_board.id)
    assert data["card_id"] == str(test_card.id)


# --- ?format=markdown / ?summary_only ---------------------------------------


async def test_get_note_markdown_format(
    client: AsyncClient, test_workspace: Workspace
):
    # A note created FROM markdown is stored as canonical PM JSON; requesting
    # ?format=markdown must serialize it back to equivalent markdown.
    create_resp = await client.post(
        BASE_URL,
        json={"title": "MD Note", "content": "This is **bold** text."},
    )
    assert create_resp.status_code == 201
    note_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{note_id}?format=markdown")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == note_id
    assert data["content"] == "This is **bold** text."
    # Everything else is unchanged.
    assert data["title"] == "MD Note"


async def test_get_note_format_prosemirror_default(
    client: AsyncClient, test_workspace: Workspace
):
    import json

    create_resp = await client.post(
        BASE_URL, json={"title": "PM Note", "content": "Plain body"}
    )
    note_id = create_resp.json()["id"]

    # No format param → raw PM JSON (back-compat).
    response = await client.get(f"{BASE_URL}/{note_id}")
    assert response.status_code == 200
    stored = json.loads(response.json()["content"])
    assert stored["type"] == "doc"

    # Explicit format=prosemirror is identical.
    explicit = await client.get(f"{BASE_URL}/{note_id}?format=prosemirror")
    assert explicit.status_code == 200
    assert explicit.json()["content"] == response.json()["content"]


async def test_get_note_invalid_format_422(
    client: AsyncClient, test_workspace: Workspace
):
    create_resp = await client.post(BASE_URL, json={"title": "X"})
    note_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{note_id}?format=html")
    assert response.status_code == 422


async def test_list_notes_summary_only_omits_content(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(BASE_URL, json={"title": "N1", "content": "body one"})
    await client.post(BASE_URL, json={"title": "N2", "content": "body two"})

    response = await client.get(f"{BASE_URL}?summary_only=true")
    assert response.status_code == 200
    notes = response.json()
    assert len(notes) == 2
    for note in notes:
        assert "content" not in note
        # The light fields are still present.
        assert "id" in note
        assert "title" in note
        assert "pinned" in note
        assert "kind" in note
        assert "created_at" in note
        assert "updated_at" in note


async def test_list_notes_default_includes_content(
    client: AsyncClient, test_workspace: Workspace
):
    await client.post(BASE_URL, json={"title": "N1", "content": "body one"})

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    notes = response.json()
    assert len(notes) == 1
    assert "content" in notes[0]
