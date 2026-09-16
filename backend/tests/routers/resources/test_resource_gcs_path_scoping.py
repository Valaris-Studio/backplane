# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Cross-tenant GCS path scoping on resource creation.

`ResourceCreate.gcs_path` is client-supplied and stored verbatim, while the
download-url endpoints sign whatever is stored. Since the resource genuinely
belongs to the caller's workspace, the authz check passes — so an unscoped
`gcs_path` is a cross-tenant object read. Creation is the only ingress
(`ResourceUpdate` has no `gcs_path`).
"""

import posixpath
import uuid

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace


BASE_URL = "/api/workspaces/default/resources"


def board_url(board_id: uuid.UUID) -> str:
    return f"/api/workspaces/default/boards/{board_id}/resources"


async def test_create_resource_rejects_foreign_workspace_gcs_path(
    client: AsyncClient, test_workspace: Workspace
):
    foreign_workspace_id = uuid.uuid4()
    foreign_path = f"{foreign_workspace_id}/stolen/secret.pdf"

    response = await client.post(
        BASE_URL,
        json={
            "name": "secret.pdf",
            "resource_type": "file",
            "gcs_path": foreign_path,
        },
    )

    assert response.status_code == 422, (
        "expected the foreign-prefixed gcs_path to be rejected, "
        f"got {response.status_code}: {response.text}"
    )

    # The rejection must be a real refusal, not a silently-created resource.
    listing = await client.get(BASE_URL)
    assert listing.status_code == 200
    assert all(
        r["gcs_path"] != foreign_path for r in listing.json()
    ), "resource was persisted with a foreign-workspace gcs_path"


async def test_create_resource_rejects_traversal_in_gcs_path(
    client: AsyncClient, test_workspace: Workspace
):
    # Passes a naive `startswith(f"{workspace_id}/")` check while the resolved
    # object key escapes the caller's prefix.
    foreign_workspace_id = uuid.uuid4()
    traversal_path = f"{test_workspace.id}/../{foreign_workspace_id}/secret.pdf"

    response = await client.post(
        BASE_URL,
        json={
            "name": "secret.pdf",
            "resource_type": "file",
            "gcs_path": traversal_path,
        },
    )

    assert response.status_code == 422, (
        "expected the traversal gcs_path to be rejected, "
        f"got {response.status_code}: {response.text}"
    )

    listing = await client.get(BASE_URL)
    assert listing.status_code == 200
    assert all(
        r["gcs_path"] != traversal_path for r in listing.json()
    ), "resource was persisted with a traversal gcs_path"


async def test_create_resource_accepts_own_workspace_gcs_path(
    client: AsyncClient, test_workspace: Workspace
):
    # Exactly the shape /upload-url mints — must keep working, and must be
    # stored unchanged so the signed download resolves to the uploaded object.
    own_path = f"{test_workspace.id}/{uuid.uuid4()}/file.pdf"

    response = await client.post(
        BASE_URL,
        json={
            "name": "file.pdf",
            "resource_type": "file",
            "gcs_path": own_path,
        },
    )

    assert response.status_code == 201
    assert response.json()["gcs_path"] == own_path


async def test_create_resource_without_gcs_path_still_autogenerates(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(
        BASE_URL,
        json={"name": "report.pdf", "resource_type": "file"},
    )

    assert response.status_code == 201
    gcs_path = response.json()["gcs_path"]
    assert gcs_path is not None
    assert gcs_path.startswith(f"{test_workspace.id}/")
    assert gcs_path.endswith("/report.pdf")


async def test_create_resource_name_cannot_escape_the_generated_prefix(
    client: AsyncClient, test_workspace: Workspace
):
    """The auto-generated key interpolates `name`, which is attacker-controlled.

    Supplying no gcs_path at all routes around any guard on the supplied-path
    branch, so a name carrying `../` segments composes a key that normalises
    into another workspace's prefix — the same cross-tenant read by a second
    door. The stored key must stay confined however the name is spelled.
    """
    foreign_workspace_id = uuid.uuid4()

    response = await client.post(
        BASE_URL,
        json={
            "name": f"../../{foreign_workspace_id}/secret.pdf",
            "resource_type": "file",
        },
    )

    if response.status_code == 201:
        gcs_path = response.json()["gcs_path"]
        assert posixpath.normpath(gcs_path).startswith(f"{test_workspace.id}/"), (
            "the generated key escaped the caller's workspace prefix: "
            f"{gcs_path!r} normalises to {posixpath.normpath(gcs_path)!r}"
        )
    else:
        assert response.status_code == 422, (
            f"expected the traversal name to be confined or refused, got {response.text}"
        )


async def test_create_board_resource_rejects_foreign_workspace_gcs_path(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    foreign_workspace_id = uuid.uuid4()
    foreign_path = f"{foreign_workspace_id}/stolen/secret.pdf"

    response = await client.post(
        board_url(test_board.id),
        json={
            "name": "secret.pdf",
            "resource_type": "file",
            "gcs_path": foreign_path,
        },
    )

    assert response.status_code == 422, (
        "expected the foreign-prefixed gcs_path to be rejected on the board "
        f"router, got {response.status_code}: {response.text}"
    )

    listing = await client.get(board_url(test_board.id))
    assert listing.status_code == 200
    assert all(
        r["gcs_path"] != foreign_path for r in listing.json()
    ), "board resource was persisted with a foreign-workspace gcs_path"


async def test_download_url_never_signs_foreign_workspace_path(
    client: AsyncClient, test_workspace: Workspace
):
    """End-to-end proof of the cross-tenant read: create then download."""
    foreign_workspace_id = uuid.uuid4()
    foreign_path = f"{foreign_workspace_id}/stolen/secret.pdf"

    create_resp = await client.post(
        BASE_URL,
        json={
            "name": "secret.pdf",
            "resource_type": "file",
            "gcs_path": foreign_path,
        },
    )

    if create_resp.status_code == 201:
        resource_id = create_resp.json()["id"]
        download_resp = await client.get(f"{BASE_URL}/{resource_id}/download-url")
        assert str(foreign_workspace_id) not in download_resp.text, (
            "download-url signed a path under another workspace's prefix: "
            f"{download_resp.text}"
        )
    else:
        assert create_resp.status_code == 422
