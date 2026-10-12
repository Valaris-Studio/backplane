# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Durable resource links, board scoping, and server-derived file facts.

- `GET …/resources/{id}/content` is the link notes embed for a resource:
  302 to a fresh signed URL (or a hardened local stream), with every
  non-servable case collapsed into one 404.
- `/download-url` keeps its shipped 400/422 contract and now also hands out
  the durable `content_url`.
- Board routes only serve that board's resources (card 20aae3ac #1).
- `create_resource` with a `gcs_path` takes type and size from the stored
  object and refuses one that was never uploaded (owner Q4).
"""

import uuid
from pathlib import Path
from urllib.parse import urlsplit

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.kanban.board import Board
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace
from app.services.media.signed_url_cache import signed_url_cache
from tests.routers.media_fakes import FAKE_BUCKET, install_fake_gcs

BASE = "/api/workspaces/default/resources"


@pytest.fixture(autouse=True)
def _fresh_signed_url_cache():
    signed_url_cache.clear()
    yield
    signed_url_cache.clear()


@pytest.fixture
def local_mode(monkeypatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(settings, "GCS_BUCKET", "")
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    return tmp_path


async def _resource(
    db_session: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    gcs_path: str | None,
    resource_type: ResourceType = ResourceType.file,
    board_id: uuid.UUID | None = None,
    workspace_id: uuid.UUID | None = None,
) -> Resource:
    resource = Resource(
        workspace_id=workspace_id or workspace.id,
        board_id=board_id,
        resource_type=resource_type,
        name="spec.pdf",
        gcs_path=gcs_path,
        uploaded_by=user.id,
        meta={},
    )
    db_session.add(resource)
    await db_session.flush()
    return resource


# --- /content --------------------------------------------------------------


async def test_resource_content_redirects_to_signed_url(
    client: AsyncClient, db_session, test_workspace, test_user, monkeypatch
):
    fake = install_fake_gcs(monkeypatch)
    key = f"{test_workspace.id}/{uuid.uuid4()}/spec.pdf"
    fake.add(key, "application/pdf")
    resource = await _resource(db_session, test_workspace, test_user, gcs_path=key)

    resp = await client.get(f"{BASE}/{resource.id}/content")

    assert resp.status_code == 302
    location = urlsplit(resp.headers["location"])
    assert location.hostname == "storage.googleapis.com"
    assert location.path.startswith(f"/{FAKE_BUCKET}/{test_workspace.id}/")
    assert resp.headers["cache-control"] == "private, max-age=300"
    assert fake.sign_calls[0][2] == "attachment; filename*=UTF-8''spec.pdf"


async def test_resource_content_streams_locally(
    client: AsyncClient, db_session, test_workspace, test_user, local_mode: Path
):
    key = f"{test_workspace.id}/{uuid.uuid4()}/page.html"
    (local_mode / key).parent.mkdir(parents=True)
    (local_mode / key).write_bytes(b"<script>")
    resource = await _resource(db_session, test_workspace, test_user, gcs_path=key)

    resp = await client.get(f"{BASE}/{resource.id}/content")

    assert resp.status_code == 200
    assert resp.content == b"<script>"
    assert resp.headers["content-disposition"].startswith("attachment;")
    assert "sandbox" in resp.headers["content-security-policy"]


@pytest.mark.parametrize(
    "case", ["folder", "no_file", "other_workspace", "malformed_id", "unknown_id", "foreign_key", "missing_blob"]
)
async def test_resource_content_non_servable_is_one_uniform_404(
    client: AsyncClient, db_session, test_workspace, test_user, monkeypatch, case: str
):
    fake = install_fake_gcs(monkeypatch)

    other = Workspace(name="Other", slug="other-ws", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    own_key = f"{test_workspace.id}/{uuid.uuid4()}/x.pdf"
    fake.add(own_key)
    targets = {
        "folder": lambda: _resource(db_session, test_workspace, test_user, gcs_path=None, resource_type=ResourceType.folder),
        "no_file": lambda: _resource(db_session, test_workspace, test_user, gcs_path=None),
        "other_workspace": lambda: _resource(
            db_session, test_workspace, test_user, gcs_path=f"{other.id}/{uuid.uuid4()}/x.pdf", workspace_id=other.id
        ),
        "foreign_key": lambda: _resource(
            db_session, test_workspace, test_user, gcs_path=f"{other.id}/{uuid.uuid4()}/x.pdf"
        ),
        "missing_blob": lambda: _resource(
            db_session, test_workspace, test_user, gcs_path=f"{test_workspace.id}/{uuid.uuid4()}/gone.pdf"
        ),
    }
    if case == "malformed_id":
        resource_ref = "not-a-uuid"
    elif case == "unknown_id":
        resource_ref = str(uuid.uuid4())
    else:
        resource_ref = str((await targets[case]()).id)
    reference = await client.get(f"{BASE}/{uuid.uuid4()}/content")

    resp = await client.get(f"{BASE}/{resource_ref}/content")

    assert reference.status_code == 404
    assert resp.status_code == 404
    assert resp.json() == reference.json()
    assert fake.sign_calls == []


# --- /download-url keeps its contract, gains content_url -------------------


async def test_download_url_still_400_for_folder_and_no_file(
    client: AsyncClient, db_session, test_workspace, test_user, test_board: Board
):
    folder = await _resource(
        db_session, test_workspace, test_user, gcs_path=None,
        resource_type=ResourceType.folder, board_id=test_board.id,
    )
    no_file = await _resource(db_session, test_workspace, test_user, gcs_path=None, board_id=test_board.id)
    board_base = f"/api/workspaces/default/boards/{test_board.id}/resources"

    for base in (BASE, board_base):
        for resource in (folder, no_file):
            resp = await client.get(f"{base}/{resource.id}/download-url")
            assert resp.status_code == 400, (base, resp.text)


async def test_download_url_includes_durable_content_url(
    client: AsyncClient, db_session, test_workspace, test_user, monkeypatch
):
    fake = install_fake_gcs(monkeypatch)
    key = f"{test_workspace.id}/{uuid.uuid4()}/spec.pdf"
    fake.add(key)
    resource = await _resource(db_session, test_workspace, test_user, gcs_path=key)

    data = (await client.get(f"{BASE}/{resource.id}/download-url")).json()

    assert data["download_url"].startswith("https://storage.googleapis.com/")
    assert data["content_url"] == f"/api/workspaces/default/resources/{resource.id}/content"
    assert data["expires_in"] == 3600


# --- board scoping (20aae3ac #1) -------------------------------------------


async def test_board_routes_refuse_resources_of_another_board(
    client: AsyncClient, db_session, test_workspace, test_user, test_board: Board, local_mode
):
    other_board = Board(workspace_id=test_workspace.id, name="B2", slug="b2", created_by=test_user.id)
    db_session.add(other_board)
    await db_session.flush()
    key = f"{test_workspace.id}/{uuid.uuid4()}/x.pdf"
    on_other_board = await _resource(db_session, test_workspace, test_user, gcs_path=key, board_id=other_board.id)
    workspace_level = await _resource(db_session, test_workspace, test_user, gcs_path=key)
    on_this_board = await _resource(db_session, test_workspace, test_user, gcs_path=key, board_id=test_board.id)
    board_base = f"/api/workspaces/default/boards/{test_board.id}/resources"

    for resource in (on_other_board, workspace_level):
        assert (await client.get(f"{board_base}/{resource.id}")).status_code == 404
        assert (await client.get(f"{board_base}/{resource.id}/download-url")).status_code == 404
    assert (await client.get(f"{board_base}/{on_this_board.id}")).status_code == 200
    assert (await client.get(f"{board_base}/{on_this_board.id}/download-url")).status_code == 200


@pytest.mark.parametrize("method", ["get", "download-url", "put", "delete"])
async def test_every_board_resource_route_404s_another_boards_resource(
    client: AsyncClient, db_session, test_workspace, test_user, test_board: Board, local_mode, method: str
):
    """Board scoping must hold on writes too: a member of the workspace could
    otherwise rename or delete another board's file through this board's URL."""
    other_board = Board(workspace_id=test_workspace.id, name="B2", slug="b2", created_by=test_user.id)
    db_session.add(other_board)
    await db_session.flush()
    key = f"{test_workspace.id}/{uuid.uuid4()}/x.pdf"
    board_base = f"/api/workspaces/default/boards/{test_board.id}/resources"
    reference = (await client.get(f"{board_base}/{uuid.uuid4()}")).json()

    async def call(resource_id):
        if method == "get":
            return await client.get(f"{board_base}/{resource_id}")
        if method == "download-url":
            return await client.get(f"{board_base}/{resource_id}/download-url")
        if method == "put":
            return await client.put(f"{board_base}/{resource_id}", json={"name": "hijacked.pdf"})
        return await client.delete(f"{board_base}/{resource_id}")

    for foreign in (
        await _resource(db_session, test_workspace, test_user, gcs_path=key, board_id=other_board.id),
        await _resource(db_session, test_workspace, test_user, gcs_path=key),
    ):
        resp = await call(foreign.id)
        assert resp.status_code == 404, resp.text
        assert resp.json() == reference
        await db_session.refresh(foreign)
        assert foreign.name == "spec.pdf"

    own = await _resource(db_session, test_workspace, test_user, gcs_path=key, board_id=test_board.id)
    assert (await call(own.id)).status_code in (200, 204)


async def test_listing_children_of_a_folder_outside_the_route_scope_is_404(
    client: AsyncClient, db_session, test_workspace, test_user, test_board: Board
):
    other_board = Board(workspace_id=test_workspace.id, name="B2", slug="b2", created_by=test_user.id)
    foreign_ws = Workspace(name="Far", slug="far", created_by=test_user.id)
    db_session.add_all([other_board, foreign_ws])
    await db_session.flush()
    folder = ResourceType.folder
    other_board_folder = await _resource(
        db_session, test_workspace, test_user, gcs_path=None, resource_type=folder, board_id=other_board.id
    )
    foreign_folder = await _resource(
        db_session, test_workspace, test_user, gcs_path=None, resource_type=folder, workspace_id=foreign_ws.id
    )
    own_folder = await _resource(
        db_session, test_workspace, test_user, gcs_path=None, resource_type=folder, board_id=test_board.id
    )
    board_base = f"/api/workspaces/default/boards/{test_board.id}/resources"

    assert (await client.get(board_base, params={"parent_id": str(other_board_folder.id)})).status_code == 404
    assert (await client.get(board_base, params={"parent_id": str(foreign_folder.id)})).status_code == 404
    assert (await client.get(BASE, params={"parent_id": str(foreign_folder.id)})).status_code == 404
    assert (await client.get(board_base, params={"parent_id": str(own_folder.id)})).status_code == 200
    assert (await client.get(BASE, params={"parent_id": str(other_board_folder.id)})).status_code == 200


# --- create_resource derives type/size from the stored object --------------


async def test_create_resource_takes_type_and_size_from_stored_object(
    client: AsyncClient, test_workspace, monkeypatch
):
    fake = install_fake_gcs(monkeypatch)
    key = f"{test_workspace.id}/{uuid.uuid4()}/spec.pdf"
    fake.add(key, "application/pdf", 2048)

    resp = await client.post(
        BASE,
        json={"name": "spec.pdf", "gcs_path": key, "mime_type": "text/plain", "size_bytes": 1},
    )

    assert resp.status_code == 201, resp.text
    assert (resp.json()["mime_type"], resp.json()["size_bytes"]) == ("application/pdf", 2048)


async def test_create_resource_local_mode_stats_the_file(
    client: AsyncClient, test_workspace, local_mode: Path
):
    key = f"{test_workspace.id}/{uuid.uuid4()}/notes.txt"
    (local_mode / key).parent.mkdir(parents=True)
    (local_mode / key).write_bytes(b"12345")

    resp = await client.post(BASE, json={"name": "notes.txt", "gcs_path": key})

    assert resp.status_code == 201, resp.text
    assert (resp.json()["mime_type"], resp.json()["size_bytes"]) == ("text/plain", 5)


async def test_create_resource_refuses_object_never_uploaded(
    client: AsyncClient, test_workspace, local_mode: Path
):
    key = f"{test_workspace.id}/{uuid.uuid4()}/ghost.pdf"

    resp = await client.post(BASE, json={"name": "ghost.pdf", "gcs_path": key})

    assert resp.status_code == 422
    assert resp.json()["error_code"] == "object_not_uploaded"
    assert all(r["gcs_path"] != key for r in (await client.get(BASE)).json())


async def test_create_resource_unreachable_bucket_is_503(
    client: AsyncClient, test_workspace, monkeypatch
):
    fake = install_fake_gcs(monkeypatch)
    fake.bucket_unreachable = True

    resp = await client.post(
        BASE, json={"name": "a.pdf", "gcs_path": f"{test_workspace.id}/{uuid.uuid4()}/a.pdf"}
    )

    assert resp.status_code == 503
    assert resp.json()["error_code"] == "storage_backend_unavailable"


async def test_create_resource_without_gcs_path_needs_no_object(
    client: AsyncClient, test_workspace, local_mode: Path
):
    resp = await client.post(BASE, json={"name": "later.pdf", "mime_type": "application/pdf"})

    assert resp.status_code == 201
    assert resp.json()["mime_type"] == "application/pdf"
