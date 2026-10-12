# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP pin for obstacle #2: read a note as markdown, write it back, lose nothing.

This is exactly what an MCP agent does (`get_note(format="markdown")` →
`update_note(content=<markdown>)`). Images and attachments must come back as the
same nodes, and a signed URL written as markdown must still be stored as the
stable relative path by the save-time canonicaliser.
"""
import json
import uuid

from httpx import AsyncClient

from app.config import settings
from app.models.workspace import Workspace

BASE_URL = "/api/workspaces/default/notes"
OBJECT_ID = uuid.UUID("33333333-3333-4333-8333-333333333333")
RESOURCE_ID = uuid.UUID("44444444-4444-4444-8444-444444444444")
STABLE_IMAGE = f"/api/workspaces/default/media/{OBJECT_ID}/shot.png"
STABLE_RESOURCE = f"/api/workspaces/default/resources/{RESOURCE_ID}/content"

_HUMAN_DOC = {
    "type": "doc",
    "content": [
        {"type": "paragraph", "content": [{"type": "text", "text": "Before"}]},
        {"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "Login", "title": "Step 1"}},
        {
            "type": "fileAttachment",
            "attrs": {
                "src": STABLE_RESOURCE,
                "filename": "spec.pdf",
                "fileSize": 2048,
                "mimeType": "application/pdf",
                "uploading": False,
            },
        },
        {"type": "paragraph", "content": [{"type": "text", "text": "After"}]},
    ],
}


async def test_markdown_read_then_write_back_keeps_images_and_attachments(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(BASE_URL, json={"title": "Human note", "content": json.dumps(_HUMAN_DOC)})
    assert created.status_code == 201
    note_id = created.json()["id"]

    read = await client.get(f"{BASE_URL}/{note_id}?format=markdown")
    markdown = read.json()["content"]
    edited = markdown.replace("After", "After, edited by an agent")

    written = await client.put(f"{BASE_URL}/{note_id}", json={"content": edited})
    assert written.status_code == 200

    nodes = json.loads(written.json()["content"])["content"]
    assert [node["type"] for node in nodes] == ["paragraph", "image", "fileAttachment", "paragraph"]
    assert nodes[1]["attrs"] == {"src": STABLE_IMAGE, "alt": "Login", "title": "Step 1"}
    assert nodes[2]["attrs"] == {
        "src": STABLE_RESOURCE,
        "filename": "spec.pdf",
        "fileSize": 2048,
        "mimeType": "application/pdf",
    }
    assert nodes[3]["content"][0]["text"] == "After, edited by an agent"


async def test_markdown_image_with_signed_url_is_stored_as_stable_path(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "GCS_BUCKET", "fake-media-bucket")
    signed = (
        f"https://storage.googleapis.com/fake-media-bucket/media/{test_workspace.id}/{OBJECT_ID}/shot.png"
        "?X-Goog-Expires=3600&X-Goog-Signature=abc"
    )

    created = await client.post(BASE_URL, json={"title": "Agent note", "content": f"![Login]({signed})"})

    assert created.status_code == 201
    nodes = json.loads(created.json()["content"])["content"]
    assert nodes == [{"type": "image", "attrs": {"src": STABLE_IMAGE, "alt": "Login", "title": None}}]
