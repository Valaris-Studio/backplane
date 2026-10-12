# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every rich-text save stores stable media paths, never signed URLs (WP2 §2).

Stale browser tabs, an older frontend during a rolling deploy, and agents
pasting `get_download_url` output all hand the backend signed URLs; storing
one breaks the image an hour later. Legacy plain-text values must still save
exactly as before.
"""

import json
import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.column import Column
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace
from tests.routers.media_fakes import FAKE_BUCKET, install_fake_gcs


@pytest.fixture
def bucket(monkeypatch):
    return install_fake_gcs(monkeypatch)


def _signed(key: str) -> str:
    return f"https://storage.googleapis.com/{FAKE_BUCKET}/{key}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=deadbeef"


@pytest.fixture
def media(test_workspace: Workspace):
    object_id = uuid.uuid4()
    key = f"media/{test_workspace.id}/{object_id}/shot.png"
    return _signed(key), f"/api/workspaces/default/media/{object_id}/shot.png"


def _doc_with_image(src: str) -> str:
    return json.dumps({"type": "doc", "content": [{"type": "image", "attrs": {"src": src}}]})


def _image_src(stored: str) -> str:
    return json.loads(stored)["content"][0]["attrs"]["src"]


# --- notes -----------------------------------------------------------------


async def test_note_create_and_update_store_stable_media_path(
    client: AsyncClient, test_workspace, test_board: Board, bucket, media
):
    signed, stable = media
    base = f"/api/workspaces/default/boards/{test_board.id}/notes"

    created = await client.post(base, json={"title": "n", "content": _doc_with_image(signed)})
    assert created.status_code == 201, created.text
    assert _image_src(created.json()["content"]) == stable

    updated = await client.put(
        f"{base}/{created.json()['id']}", json={"content": _doc_with_image(signed)}
    )
    assert _image_src(updated.json()["content"]) == stable


async def test_note_append_and_section_replace_store_stable_media_path(
    client: AsyncClient, test_workspace, test_board: Board, bucket, media
):
    signed, stable = media
    base = f"/api/workspaces/default/boards/{test_board.id}/notes"
    heading = {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Shots"}]}
    note = (
        await client.post(base, json={"title": "n", "content": json.dumps({"type": "doc", "content": [heading]})})
    ).json()

    appended = await client.post(f"{base}/{note['id']}/append", json={"content": _doc_with_image(signed)})
    assert signed not in appended.json()["content"]
    assert stable in appended.json()["content"]

    replaced = await client.post(
        f"{base}/{note['id']}/replace-section",
        json={"anchor_heading": "Shots", "content": _doc_with_image(signed)},
    )
    assert replaced.status_code == 200, replaced.text
    assert signed not in replaced.json()["content"]


async def test_workspace_note_maps_resource_link_to_content_path(
    client: AsyncClient, db_session: AsyncSession, test_workspace, test_user: User, bucket
):
    key = f"{test_workspace.id}/{uuid.uuid4()}/spec.pdf"
    resource = Resource(
        workspace_id=test_workspace.id, resource_type=ResourceType.file, name="spec.pdf",
        gcs_path=key, uploaded_by=test_user.id, meta={},
    )
    db_session.add(resource)
    await db_session.flush()
    content = json.dumps({
        "type": "doc",
        "content": [{"type": "paragraph", "content": [
            {"type": "text", "text": "spec", "marks": [{"type": "link", "attrs": {"href": _signed(key)}}]}
        ]}],
    })

    created = await client.post("/api/workspaces/default/notes", json={"title": "n", "content": content})

    assert f"/api/workspaces/default/resources/{resource.id}/content" in created.json()["content"]


# --- cards -----------------------------------------------------------------


async def test_card_create_bulk_and_update_store_stable_media_path(
    client: AsyncClient, test_workspace, test_board: Board, test_column: Column, bucket, media
):
    signed, stable = media
    base = f"/api/workspaces/default/boards/{test_board.id}/cards"
    payload = {"title": "c", "column_id": str(test_column.id), "description": _doc_with_image(signed)}

    created = await client.post(base, json=payload)
    assert created.status_code == 201, created.text
    assert _image_src(created.json()["description"]) == stable

    bulk = await client.post(f"{base}/bulk", json={"cards": [payload]})
    assert bulk.status_code == 201, bulk.text
    assert _image_src(bulk.json()["cards"][0]["description"]) == stable

    updated = await client.patch(
        f"{base}/{created.json()['id']}", json={"description": _doc_with_image(signed)}
    )
    assert _image_src(updated.json()["description"]) == stable


# --- boards ----------------------------------------------------------------


async def test_board_create_and_update_store_stable_media_path(
    client: AsyncClient, test_workspace, bucket, media
):
    signed, stable = media

    created = await client.post(
        "/api/workspaces/default/boards", json={"name": "B", "description": _doc_with_image(signed)}
    )
    assert created.status_code == 201, created.text
    assert _image_src(created.json()["description"]) == stable

    updated = await client.patch(
        f"/api/workspaces/default/boards/{created.json()['id']}",
        json={"description": f"legacy markdown ![x]({signed})"},
    )
    assert updated.json()["description"] == f"legacy markdown ![x]({stable})"


async def test_legacy_plain_text_board_description_saves_unchanged(
    client: AsyncClient, test_workspace, test_board: Board, bucket
):
    for legacy in ("just words", "{not json at all", "<p>html <b>bold</b></p>"):
        resp = await client.patch(
            f"/api/workspaces/default/boards/{test_board.id}", json={"description": legacy}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["description"] == legacy


# --- definitions -----------------------------------------------------------


async def test_definition_scope_and_nested_rationale_store_stable_media_path(
    client: AsyncClient, test_workspace, test_board: Board, bucket, media
):
    signed, stable = media
    url = f"/api/workspaces/default/boards/{test_board.id}/definitions"

    resp = await client.put(
        url,
        json={
            "scope": _doc_with_image(signed),
            "content": {
                "decisions": [
                    {"decision": "plain", "rationale": "legacy plain text rationale"},
                    {"decision": "img", "rationale": _doc_with_image(signed)},
                ]
            },
        },
    )

    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert _image_src(data["scope"]) == stable
    assert data["content"]["decisions"][0]["rationale"] == "legacy plain text rationale"
    assert _image_src(data["content"]["decisions"][1]["rationale"]) == stable


async def test_non_media_rich_text_saves_byte_identical(
    client: AsyncClient, test_workspace, test_board: Board, bucket
):
    description = _doc_with_image("https://example.com/cat.png")

    resp = await client.patch(
        f"/api/workspaces/default/boards/{test_board.id}", json={"description": description}
    )

    assert resp.json()["description"] == description


async def test_absolute_own_origin_stable_link_is_stored_relative(
    client: AsyncClient, test_workspace, test_board: Board, monkeypatch
):
    """The pre-PR-B editor prefixes `window.location.origin`; only our own
    origin is stripped, a look-alike host is kept as written."""
    from app.config import settings

    monkeypatch.setattr(settings, "FRONTEND_URL", "https://app.example.test")
    stable = f"/api/workspaces/default/media/{uuid.uuid4()}/shot.png"
    foreign = "https://elsewhere.example" + stable

    resp = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/notes",
        json={"title": "n", "content": json.dumps({"type": "doc", "content": [
            {"type": "image", "attrs": {"src": "https://app.example.test" + stable}},
            {"type": "image", "attrs": {"src": foreign}},
        ]})},
    )

    srcs = [n["attrs"]["src"] for n in json.loads(resp.json()["content"])["content"]]
    assert srcs == [stable, foreign]
