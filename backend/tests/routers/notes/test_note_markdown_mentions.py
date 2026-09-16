# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""MCP-read pin: mention/image/fileAttachment must survive ?format=markdown.

A note stored as canonical PM JSON can legally contain mention, image and
fileAttachment nodes (the editor emits them; the normalizer passes PM JSON
through unchanged). The `?format=markdown` read serializes via
`prosemirror_to_markdown`, whose unknown-node fallback currently drops all
three — so `get_note(format=markdown)` silently loses every mention, image and
attachment. RED today (editor P0-4) until the serializer gains the rules.
"""
import json

from httpx import AsyncClient

from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/notes"

# Canonical PM JSON as the editor would store it — passes through the
# normalizer unchanged, so the loss under test happens only at read time.
_RICH_DOC = json.dumps(
    {
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {"type": "mention", "attrs": {"id": "u1", "label": "Ana"}},
                    {"type": "text", "text": " please review"},
                ],
            },
            {
                "type": "image",
                "attrs": {"src": "https://img/x.png", "alt": "diagram"},
            },
            {
                "type": "fileAttachment",
                "attrs": {"filename": "spec.pdf", "src": "https://f/spec.pdf"},
            },
        ],
    }
)


async def _create_rich_note(client: AsyncClient) -> str:
    create_resp = await client.post(
        BASE_URL, json={"title": "Rich note", "content": _RICH_DOC}
    )
    assert create_resp.status_code == 201
    return create_resp.json()["id"]


async def _read_markdown(client: AsyncClient, note_id: str) -> str:
    response = await client.get(f"{BASE_URL}/{note_id}?format=markdown")
    assert response.status_code == 200
    return response.json()["content"]


async def test_get_note_markdown_keeps_mention(
    client: AsyncClient, test_workspace: Workspace
):
    note_id = await _create_rich_note(client)
    markdown = await _read_markdown(client, note_id)
    assert "@Ana" in markdown


async def test_get_note_markdown_keeps_image(
    client: AsyncClient, test_workspace: Workspace
):
    note_id = await _create_rich_note(client)
    markdown = await _read_markdown(client, note_id)
    assert "![" in markdown
    assert "![diagram](https://img/x.png)" in markdown


async def test_get_note_markdown_keeps_file_attachment(
    client: AsyncClient, test_workspace: Workspace
):
    note_id = await _create_rich_note(client)
    markdown = await _read_markdown(client, note_id)
    assert "[spec.pdf](https://f/spec.pdf)" in markdown
