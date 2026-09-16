# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP surface for surgical section replace, board-scoped and workspace-level.

Routing mirrors append: the same note_id works under either prefix, and the
loaded note's own scope — not the URL — decides the freeze/immutability gate.
The status codes are the contract callers key on, so each is pinned here.
"""
import json
import uuid

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace

BOARD_URL = "/api/workspaces/default/boards/{board_id}/notes"
WORKSPACE_URL = "/api/workspaces/default/notes"

TRACKER = "# Plan\n\n## Cluster I\n\nIn progress.\n\n## Cluster II\n\nNot started.\n"


async def _create(client: AsyncClient, url: str, content: str) -> dict:
    response = await client.post(url, json={"title": "Plan of Record", "content": content})
    assert response.status_code == 201
    return response.json()


def _texts(body: dict) -> list[str]:
    return [
        "".join(part.get("text", "") for part in block.get("content") or [])
        for block in json.loads(body["content"])["content"]
    ]


async def test_replace_board_note_section_preserves_prefix_and_suffix(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    note = await _create(client, url, TRACKER)
    before = json.loads(note["content"])["content"]

    response = await client.post(
        f"{url}/{note['id']}/replace-section",
        json={"anchor_heading": "Cluster I", "content": "Done."},
    )

    assert response.status_code == 200
    after = json.loads(response.json()["content"])["content"]
    assert after[:2] == before[:2]
    assert after[-2:] == before[-2:]
    assert _texts(response.json()) == ["Plan", "Cluster I", "Done.", "Cluster II", "Not started."]


async def test_replace_workspace_note_section(
    client: AsyncClient, test_workspace: Workspace
):
    note = await _create(client, WORKSPACE_URL, TRACKER)

    response = await client.post(
        f"{WORKSPACE_URL}/{note['id']}/replace-section",
        json={"anchor_heading": "Cluster II", "content": "Started."},
    )

    assert response.status_code == 200
    assert _texts(response.json())[-1] == "Started."


async def test_replace_missing_anchor_returns_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    note = await _create(client, url, TRACKER)

    response = await client.post(
        f"{url}/{note['id']}/replace-section",
        json={"anchor_heading": "Cluster IX", "content": "x"},
    )

    assert response.status_code == 404


async def test_replace_ambiguous_anchor_returns_409(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    note = await _create(client, url, "## Session 5\n\nFirst.\n\n## Session 5\n\nSecond.\n")

    response = await client.post(
        f"{url}/{note['id']}/replace-section",
        json={"anchor_heading": "Session 5", "content": "x"},
    )

    assert response.status_code == 409


async def test_replace_blank_anchor_is_rejected(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """A blank anchor would match nothing meaningful; rejecting at the schema
    keeps it from reading as "the caller meant the whole document"."""
    url = BOARD_URL.format(board_id=test_board.id)
    note = await _create(client, url, TRACKER)

    response = await client.post(
        f"{url}/{note['id']}/replace-section",
        json={"anchor_heading": "   ", "content": "x"},
    )

    assert response.status_code == 422


async def test_replace_unknown_note_returns_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    response = await client.post(
        f"{url}/{uuid.uuid4()}/replace-section",
        json={"anchor_heading": "Cluster I", "content": "x"},
    )
    assert response.status_code == 404


async def test_replace_leaves_title_and_pinned_untouched(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    url = BOARD_URL.format(board_id=test_board.id)
    created = await client.post(
        url, json={"title": "Pinned Tracker", "content": TRACKER, "pinned": True}
    )
    note = created.json()

    response = await client.post(
        f"{url}/{note['id']}/replace-section",
        json={"anchor_heading": "Cluster I", "content": "Done."},
    )

    body = response.json()
    assert body["title"] == "Pinned Tracker"
    assert body["pinned"] is True
