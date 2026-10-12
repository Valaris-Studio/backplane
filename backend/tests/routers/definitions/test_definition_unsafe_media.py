# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Board definitions and descriptions get the same media-src allowlist as notes.

`scope`, `decisions[].rationale` and the board description are stored rich
text that never passes the note normalizer, so the save-time canonicaliser is
where an unsafe image/attachment src (`javascript:` and friends) must be
stripped — otherwise it survives storage, `export_definition` and MCP
`get_definition`.
"""
import json

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace

BASE_URL = "/api/workspaces/default/boards"
SAFE_SRC = "/api/workspaces/default/resources/44444444-4444-4444-8444-444444444444/content"


def _doc_with_unsafe_media(src: str = "javascript:alert(document.cookie)") -> dict:
    return {
        "type": "doc",
        "content": [
            {"type": "paragraph", "content": [{"type": "text", "text": "Scope"}]},
            {"type": "fileAttachment", "attrs": {"src": src, "filename": "evil.pdf"}},
            {"type": "image", "attrs": {"src": src, "alt": "x"}},
            {"type": "image", "attrs": {"src": SAFE_SRC, "alt": "kept"}},
        ],
    }


def _assert_stripped(stored: str) -> None:
    nodes = json.loads(stored)["content"]
    assert [node["type"] for node in nodes] == ["paragraph", "fileAttachment", "image"]
    assert nodes[1]["attrs"] == {"src": None, "filename": "evil.pdf"}
    assert nodes[2]["attrs"]["src"] == SAFE_SRC
    assert "javascript" not in stored.lower()


async def test_definition_scope_json_string_strips_unsafe_media(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.put(
        f"{BASE_URL}/{test_board.id}/definitions",
        json={"scope": json.dumps(_doc_with_unsafe_media())},
    )

    assert response.status_code == 200
    _assert_stripped(response.json()["scope"])
    read = await client.get(f"{BASE_URL}/{test_board.id}/definitions")
    _assert_stripped(read.json()["scope"])


async def test_definition_rationale_in_content_dict_strips_unsafe_media(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    content = {
        "decisions": [
            {"decision": "Ship it", "rationale": json.dumps(_doc_with_unsafe_media(" java\tscript:x"))},
            {"decision": "Plain", "rationale": "No rich text here"},
        ],
    }

    response = await client.put(f"{BASE_URL}/{test_board.id}/definitions", json={"content": content})

    assert response.status_code == 200
    decisions = response.json()["content"]["decisions"]
    _assert_stripped(decisions[0]["rationale"])
    assert decisions[1]["rationale"] == "No rich text here"


async def test_definition_without_unsafe_media_is_stored_byte_identical(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    scope = json.dumps({"type": "doc", "content": [{"type": "image", "attrs": {"src": SAFE_SRC}}]})

    response = await client.put(f"{BASE_URL}/{test_board.id}/definitions", json={"scope": scope})

    assert response.json()["scope"] == scope


async def test_board_description_strips_unsafe_media(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.patch(
        f"{BASE_URL}/{test_board.id}",
        json={"description": json.dumps(_doc_with_unsafe_media("data:text/html,x"))},
    )

    assert response.status_code == 200
    _assert_stripped(response.json()["description"])
