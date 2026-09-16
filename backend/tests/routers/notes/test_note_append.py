# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP surface for surgical note append, board-scoped and workspace-level.

Routing mirrors `update_note`: the same note_id works under either prefix, and
the loaded note's own scope — not the URL — decides the freeze/immutability gate.
"""
import json

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace

BOARD_URL = "/api/workspaces/default/boards/{board_id}/notes"
WORKSPACE_URL = "/api/workspaces/default/notes"


async def _create(client: AsyncClient, url: str, content: str) -> dict:
    response = await client.post(url, json={"title": "Plan of Record", "content": content})
    assert response.status_code == 201
    return response.json()


async def test_append_board_note_preserves_prefix(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    note = await _create(client, url, "# Plan\n\nCluster I shipped.")
    before = json.loads(note["content"])["content"]

    response = await client.post(
        f"{url}/{note['id']}/append", json={"content": "## Session 5\n\nAppended."}
    )

    assert response.status_code == 200
    after = json.loads(response.json()["content"])["content"]
    assert after[: len(before)] == before
    assert after[-1]["content"][0]["text"] == "Appended."


async def test_append_workspace_note_preserves_prefix(
    client: AsyncClient, test_workspace: Workspace
):
    note = await _create(client, WORKSPACE_URL, "Original body.")
    before = json.loads(note["content"])["content"]

    response = await client.post(
        f"{WORKSPACE_URL}/{note['id']}/append", json={"content": "Second entry."}
    )

    assert response.status_code == 200
    after = json.loads(response.json()["content"])["content"]
    assert after[: len(before)] == before
    assert after[-1]["content"][0]["text"] == "Second entry."


async def test_append_empty_content_is_rejected(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    note = await _create(client, url, "Header.")

    response = await client.post(f"{url}/{note['id']}/append", json={"content": "   "})

    assert response.status_code == 422


async def test_append_unknown_note_returns_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    import uuid

    url = BOARD_URL.format(board_id=test_board.id)
    response = await client.post(f"{url}/{uuid.uuid4()}/append", json={"content": "x"})
    assert response.status_code == 404


async def test_append_leaves_title_and_pinned_untouched(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The whole point of append is that it touches content and nothing else."""
    url = BOARD_URL.format(board_id=test_board.id)
    response = await client.post(
        url, json={"title": "Pinned Tracker", "content": "Body.", "pinned": True}
    )
    note = response.json()

    appended = await client.post(f"{url}/{note['id']}/append", json={"content": "More."})

    body = appended.json()
    assert body["title"] == "Pinned Tracker"
    assert body["pinned"] is True
