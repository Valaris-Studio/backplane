# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Signing-site re-validation of stored gcs_path + upload filename validation.

Commit 20ae2cb confines `gcs_path` to the caller's workspace prefix AT CREATE
TIME, but both download-url endpoints sign `resource.gcs_path` verbatim. A
stored-but-foreign key (pre-guard row, or any future bypass of the create
guard) therefore still gets signed — a cross-tenant object read. These tests
inject the hostile row directly via db_session (the create API correctly
refuses it now) and pin that the signing site re-validates with the SAME rule
as create: 422 (`ValidationError`, matching `_validate_gcs_path`), never a URL.

Without GCS_BUCKET configured (the test environment) the endpoints return the
local-storage fallback URL for the same verbatim key — that URL grants the
read just like a signed one, so the guard must sit before the bucket branch.

Also pins `UploadUrlRequest.filename` validation: empty, whitespace-only,
trailing-slash and traversal filenames must 422 at request-validation time
instead of minting keys that fail confusingly later.
"""

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.resources.resource import Resource, ResourceType
from app.models.user import User
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/resources"


def board_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/resources"


async def _inject_resource(
    db_session: AsyncSession,
    workspace: Workspace,
    user: User,
    gcs_path: str,
    board_id: uuid.UUID | None = None,
) -> Resource:
    """Persist a file resource bypassing the create-time gcs_path guard."""
    resource = Resource(
        workspace_id=workspace.id,
        board_id=board_id,
        resource_type=ResourceType.file,
        name="stored.txt",
        gcs_path=gcs_path,
        uploaded_by=user.id,
    )
    db_session.add(resource)
    await db_session.flush()
    return resource


# --- download-url must re-validate the STORED key (workspace router) ---


async def test_download_url_refuses_foreign_workspace_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    foreign_workspace_id = uuid.uuid4()
    foreign_path = f"{foreign_workspace_id}/stolen/secret.txt"
    resource = await _inject_resource(
        db_session, test_workspace, test_user, foreign_path
    )

    response = await client.get(f"{BASE_URL}/{resource.id}/download-url")

    assert response.status_code == 422, (
        "download-url must refuse a stored key outside the caller's workspace "
        f"prefix, got {response.status_code}: {response.text}"
    )
    assert "download_url" not in response.json(), (
        f"a URL for the foreign key was handed out: {response.text}"
    )
    assert foreign_path not in response.text, (
        f"response leaked the foreign key: {response.text}"
    )


async def test_download_url_refuses_traversal_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    # Passes a naive prefix check while the resolved key escapes the workspace.
    foreign_workspace_id = uuid.uuid4()
    traversal_path = f"{test_workspace.id}/../{foreign_workspace_id}/x.txt"
    resource = await _inject_resource(
        db_session, test_workspace, test_user, traversal_path
    )

    response = await client.get(f"{BASE_URL}/{resource.id}/download-url")

    assert response.status_code == 422, (
        "download-url must refuse a stored non-normal-form key, "
        f"got {response.status_code}: {response.text}"
    )
    assert "download_url" not in response.json(), (
        f"a URL for the traversal key was handed out: {response.text}"
    )


# --- same contract on the board-scoped router ---


async def test_board_download_url_refuses_foreign_workspace_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    foreign_workspace_id = uuid.uuid4()
    foreign_path = f"{foreign_workspace_id}/stolen/secret.txt"
    resource = await _inject_resource(
        db_session, test_workspace, test_user, foreign_path, board_id=test_board.id
    )

    response = await client.get(
        f"{board_url(test_board.id)}/{resource.id}/download-url"
    )

    assert response.status_code == 422, (
        "board download-url must refuse a stored key outside the caller's "
        f"workspace prefix, got {response.status_code}: {response.text}"
    )
    assert "download_url" not in response.json(), (
        f"a URL for the foreign key was handed out: {response.text}"
    )
    assert foreign_path not in response.text, (
        f"response leaked the foreign key: {response.text}"
    )


async def test_board_download_url_refuses_traversal_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    foreign_workspace_id = uuid.uuid4()
    traversal_path = f"{test_workspace.id}/../{foreign_workspace_id}/x.txt"
    resource = await _inject_resource(
        db_session, test_workspace, test_user, traversal_path, board_id=test_board.id
    )

    response = await client.get(
        f"{board_url(test_board.id)}/{resource.id}/download-url"
    )

    assert response.status_code == 422, (
        "board download-url must refuse a stored non-normal-form key, "
        f"got {response.status_code}: {response.text}"
    )
    assert "download_url" not in response.json(), (
        f"a URL for the traversal key was handed out: {response.text}"
    )


# --- green pins: the same injection with a well-formed key must still work,
# --- proving the reds fail on the key, not on the injection technique.


async def test_download_url_returns_url_for_valid_stored_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    own_path = f"{test_workspace.id}/{uuid.uuid4()}/file.txt"
    resource = await _inject_resource(db_session, test_workspace, test_user, own_path)

    response = await client.get(f"{BASE_URL}/{resource.id}/download-url")

    assert response.status_code == 200, response.text
    assert own_path in response.json()["download_url"]


async def test_board_download_url_returns_url_for_valid_stored_key(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    own_path = f"{test_workspace.id}/{uuid.uuid4()}/file.txt"
    resource = await _inject_resource(
        db_session, test_workspace, test_user, own_path, board_id=test_board.id
    )

    response = await client.get(
        f"{board_url(test_board.id)}/{resource.id}/download-url"
    )

    assert response.status_code == 200, response.text
    assert own_path in response.json()["download_url"]


# --- upload-url filename validation (schema-level, shared by both routers) ---


async def test_upload_url_rejects_empty_filename(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "", "content_type": "application/pdf"},
    )
    assert response.status_code == 422, (
        "an empty filename mints a key ending in '/' that fails confusingly "
        f"later, got {response.status_code}: {response.text}"
    )


async def test_upload_url_rejects_whitespace_only_filename(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "   ", "content_type": "application/pdf"},
    )
    assert response.status_code == 422, (
        f"whitespace-only filename accepted, got {response.status_code}: "
        f"{response.text}"
    )


async def test_upload_url_rejects_trailing_slash_filename(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "dir/", "content_type": "application/pdf"},
    )
    assert response.status_code == 422, (
        f"trailing-slash filename accepted, got {response.status_code}: "
        f"{response.text}"
    )


async def test_upload_url_rejects_traversal_filename(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "a/../b.pdf", "content_type": "application/pdf"},
    )
    assert response.status_code == 422, (
        f"traversal filename accepted, got {response.status_code}: "
        f"{response.text}"
    )


async def test_board_upload_url_rejects_empty_filename(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.post(
        f"{board_url(test_board.id)}/upload-url",
        json={"filename": "", "content_type": "application/pdf"},
    )
    assert response.status_code == 422, (
        f"board upload-url accepted an empty filename, got "
        f"{response.status_code}: {response.text}"
    )


async def test_board_upload_url_accepts_normal_filename(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    # Green pin: the board-scoped upload flow (no existing coverage) must keep
    # working for a normal filename.
    response = await client.post(
        f"{board_url(test_board.id)}/upload-url",
        json={"filename": "report.pdf", "content_type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["gcs_path"].startswith(f"{test_workspace.id}/")
    assert data["gcs_path"].endswith("/report.pdf")


async def test_upload_url_strips_surrounding_whitespace(
    client: AsyncClient, test_workspace: Workspace
):
    # Green pin: the validator strips before minting — a mutant returning the
    # raw value would embed the padding in the object key.
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "  report.pdf  ", "content_type": "application/pdf"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["gcs_path"].endswith("/report.pdf"), (
        f"surrounding whitespace leaked into the key: {response.text}"
    )


async def test_upload_url_rejects_dots_only_filename(
    client: AsyncClient, test_workspace: Workspace
):
    # "." mints "<ws>/<uuid>/." which the create-time gcs_path guard then
    # rejects as non-normal-form — the exact confusing late failure this
    # validator exists to prevent. "..." must stay rejected even once the
    # inner-".." substring rule is relaxed (see the a..b.pdf pin).
    for filename in (".", "..."):
        response = await client.post(
            f"{BASE_URL}/upload-url",
            json={"filename": filename, "content_type": "application/pdf"},
        )
        assert response.status_code == 422, (
            f"dots-only filename {filename!r} accepted, got "
            f"{response.status_code}: {response.text}"
        )


async def test_upload_url_accepts_inner_double_dots(
    client: AsyncClient, test_workspace: Workspace
):
    # "/" is already rejected, so the filename is always a single key segment
    # and inner dots are inert — a bare ".." substring rule over-rejects.
    response = await client.post(
        f"{BASE_URL}/upload-url",
        json={"filename": "a..b.pdf", "content_type": "application/pdf"},
    )
    assert response.status_code == 200, (
        "inner double dots are harmless in a single segment, got "
        f"{response.status_code}: {response.text}"
    )
    assert response.json()["gcs_path"].endswith("/a..b.pdf")
