# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy import func, select

from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.workspace import Workspace
from app.models.kanban.board import Board


BASE = "/api/workspaces/default/boards"


def _url(board: Board, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/columns{suffix}"


async def test_create_column_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        _url(test_board), json={"name": "In Progress", "color": "#3b82f6"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "In Progress"
    assert data["color"] == "#3b82f6"
    assert data["board_id"] == str(test_board.id)


async def test_create_column_with_column_type(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        _url(test_board), json={"name": "QA Review", "column_type": "review"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "QA Review"
    assert data["column_type"] == "review"


async def test_create_column_without_column_type(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        _url(test_board), json={"name": "Parking Lot"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["column_type"] is None


async def test_update_column_type(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_column: Column
):
    # Set column_type
    response = await client.patch(
        _url(test_board, f"/{test_column.id}"),
        json={"column_type": "done"},
    )
    assert response.status_code == 200
    assert response.json()["column_type"] == "done"

    # Change to another type
    response = await client.patch(
        _url(test_board, f"/{test_column.id}"),
        json={"column_type": "review"},
    )
    assert response.status_code == 200
    assert response.json()["column_type"] == "review"


async def test_create_column_auto_position(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_column: Column
):
    response = await client.post(
        _url(test_board), json={"name": "Done"}
    )
    assert response.status_code == 201
    data = response.json()
    assert data["position"] == test_column.position + 1024.0


async def test_update_column_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_column: Column
):
    response = await client.patch(
        _url(test_board, f"/{test_column.id}"),
        json={"name": "Doing", "color": "#ef4444"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "Doing"
    assert data["color"] == "#ef4444"


async def test_update_column_not_found(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    fake_id = uuid.uuid4()
    response = await client.patch(
        _url(test_board, f"/{fake_id}"),
        json={"name": "Nope"},
    )
    assert response.status_code == 404


async def test_delete_column_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_column: Column
):
    response = await client.delete(_url(test_board, f"/{test_column.id}"))
    assert response.status_code == 204

    response = await client.patch(
        _url(test_board, f"/{test_column.id}"),
        json={"name": "Ghost"},
    )
    assert response.status_code == 404


async def test_delete_column_with_cards(
    client: AsyncClient,
    db_session,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
):
    for title in ("Card A", "Card B"):
        response = await client.post(
            f"{BASE}/{test_board.id}/cards",
            json={"title": title, "column_id": str(test_column.id)},
        )
        assert response.status_code == 201

    response = await client.delete(_url(test_board, f"/{test_column.id}"))
    assert response.status_code == 204

    card_count = await db_session.scalar(
        select(func.count()).select_from(Card).where(Card.column_id == test_column.id)
    )
    assert card_count == 0


async def test_reorder_columns(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    r1 = await client.post(_url(test_board), json={"name": "Col A"})
    r2 = await client.post(_url(test_board), json={"name": "Col B"})
    r3 = await client.post(_url(test_board), json={"name": "Col C"})

    id_a = r1.json()["id"]
    id_b = r2.json()["id"]
    id_c = r3.json()["id"]

    # Reorder: C, A, B
    response = await client.patch(
        _url(test_board, "/reorder"),
        json={"column_ids": [id_c, id_a, id_b]},
    )
    assert response.status_code == 200

    # Verify positions by fetching each column via update (no-op) to read back
    rc = await client.patch(_url(test_board, f"/{id_c}"), json={"name": "Col C"})
    ra = await client.patch(_url(test_board, f"/{id_a}"), json={"name": "Col A"})
    rb = await client.patch(_url(test_board, f"/{id_b}"), json={"name": "Col B"})

    assert rc.json()["position"] == 1024.0  # first * 1024
    assert ra.json()["position"] == 2048.0  # second * 1024
    assert rb.json()["position"] == 3072.0  # third * 1024


async def test_reorder_columns_rejects_column_from_other_board(
    client: AsyncClient, db_session, test_workspace: Workspace, test_board: Board
):
    """Reorder ids are validated against the URL board — a foreign column UUID
    must 422 and write nothing (was an IDOR-shaped cross-board position write)."""
    r_own = await client.post(_url(test_board), json={"name": "Own"})
    own_id = r_own.json()["id"]

    other_board = Board(
        workspace_id=test_workspace.id, name="Other Board", slug="other-board",
        created_by=test_board.created_by,
    )
    db_session.add(other_board)
    await db_session.flush()
    foreign = Column(board_id=other_board.id, name="Foreign", position=1024.0)
    db_session.add(foreign)
    await db_session.flush()

    response = await client.patch(
        _url(test_board, "/reorder"),
        json={"column_ids": [str(foreign.id), own_id]},
    )
    assert response.status_code == 422

    # Nothing written: foreign column untouched, own column keeps its slot
    # (a successful reorder would have moved it to index 1 -> 2048).
    await db_session.refresh(foreign)
    assert foreign.position == 1024.0
    r_read = await client.patch(_url(test_board, f"/{own_id}"), json={"name": "Own"})
    assert r_read.json()["position"] == 1024.0


async def test_reorder_columns_rejects_column_from_other_workspace(
    client: AsyncClient, db_session, test_workspace: Workspace, test_board: Board,
    second_user,
):
    """Cross-tenant variant: a workspace-B column UUID sent to workspace A's
    reorder endpoint must 422, not silently reposition B's column."""
    r_own = await client.post(_url(test_board), json={"name": "Own"})
    own_id = r_own.json()["id"]

    from app.models.workspace import WorkspaceMember, WorkspaceRole

    other_ws = Workspace(name="Tenant B", slug="tenant-b", created_by=second_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=other_ws.id, user_id=second_user.id, role=WorkspaceRole.owner
    ))
    other_board = Board(
        workspace_id=other_ws.id, name="B Board", slug="b-board",
        created_by=second_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    foreign = Column(board_id=other_board.id, name="B Column", position=1024.0)
    db_session.add(foreign)
    await db_session.flush()

    response = await client.patch(
        _url(test_board, "/reorder"),
        json={"column_ids": [str(foreign.id), own_id]},
    )
    assert response.status_code == 422

    await db_session.refresh(foreign)
    assert foreign.position == 1024.0


async def test_reorder_columns_rejects_unknown_column_id(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Unknown UUIDs 422 instead of being silently skipped — same validation
    path as foreign columns (id not in this board's set)."""
    r_own = await client.post(_url(test_board), json={"name": "Own"})
    own_id = r_own.json()["id"]

    response = await client.patch(
        _url(test_board, "/reorder"),
        json={"column_ids": [str(uuid.uuid4()), own_id]},
    )
    assert response.status_code == 422
