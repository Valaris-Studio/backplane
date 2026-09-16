# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace


def board_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/resources"


async def test_list_board_resources_empty(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(board_url(test_board.id))
    assert response.status_code == 200
    assert response.json() == []


async def test_create_board_resource_file(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        board_url(test_board.id),
        json={"name": "spec.pdf", "resource_type": "file"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "spec.pdf"
    assert data["board_id"] == str(test_board.id)
    assert data["resource_type"] == "file"


async def test_create_board_resource_folder(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        board_url(test_board.id),
        json={"name": "Designs", "resource_type": "folder"},
    )
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Designs"
    assert data["resource_type"] == "folder"
    assert data["board_id"] == str(test_board.id)


async def test_get_board_resource_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    create_resp = await client.post(
        board_url(test_board.id), json={"name": "design.fig"}
    )
    resource_id = create_resp.json()["id"]

    response = await client.get(f"{board_url(test_board.id)}/{resource_id}")
    assert response.status_code == 200
    assert response.json()["name"] == "design.fig"


async def test_update_board_resource_rename(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    create_resp = await client.post(
        board_url(test_board.id), json={"name": "old.txt"}
    )
    resource_id = create_resp.json()["id"]

    response = await client.put(
        f"{board_url(test_board.id)}/{resource_id}",
        json={"name": "renamed.txt"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "renamed.txt"


async def test_delete_board_resource_success(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    create_resp = await client.post(
        board_url(test_board.id), json={"name": "temp.txt"}
    )
    resource_id = create_resp.json()["id"]

    response = await client.delete(f"{board_url(test_board.id)}/{resource_id}")
    assert response.status_code == 204

    get_resp = await client.get(f"{board_url(test_board.id)}/{resource_id}")
    assert get_resp.status_code == 404


async def test_board_resources_isolation(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    ws_url = "/api/workspaces/default/resources"

    await client.post(ws_url, json={"name": "workspace-file.txt"})
    await client.post(board_url(test_board.id), json={"name": "board-file.txt"})

    ws_resp = await client.get(ws_url)
    board_resp = await client.get(board_url(test_board.id))

    ws_names = [r["name"] for r in ws_resp.json()]
    board_names = [r["name"] for r in board_resp.json()]

    assert "workspace-file.txt" in ws_names
    assert "board-file.txt" not in ws_names
    assert "board-file.txt" in board_names
    assert "workspace-file.txt" not in board_names
