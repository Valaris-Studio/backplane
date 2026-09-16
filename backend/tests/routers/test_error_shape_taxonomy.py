# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every error body is the canonical `ValarisError` shape."""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from httpx import AsyncClient

from app.config import settings
from app.models.kanban.board import Board
from app.models.workspace import Workspace

CANONICAL_KEYS = {"detail", "error_code", "error_params", "context"}


def assert_canonical(
    resp, *, status: int, error_code: str, context: dict | None = None
) -> None:
    """The body is the taxonomy shape — same top-level keys everywhere.

    `context` is present on every error so clients can read it unconditionally;
    it is `null` unless the raising site attached machine-readable extras.
    """
    assert resp.status_code == status
    body = resp.json()
    assert set(body) == CANONICAL_KEYS, f"non-canonical body: {body}"
    assert body["error_code"] == error_code
    assert isinstance(body["detail"], str) and body["detail"]
    assert isinstance(body["error_params"], dict)
    assert body["context"] == context


# --- 413: local-storage upload cap ------------------------------------------


async def test_oversized_upload_returns_canonical_413(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    from app.routers import local_storage

    resp = await client.put(
        f"/api/local-storage/upload/{test_workspace.id}/{uuid.uuid4()}/big.bin",
        content=b"x" * (local_storage.MAX_UPLOAD_BYTES + 1),
    )
    assert_canonical(resp, status=413, error_code="payload_too_large")


async def test_lying_content_length_returns_canonical_413(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    """The streamed tally rejects with the same shape as the declared-length path."""
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))
    from app.routers import local_storage

    resp = await client.put(
        f"/api/local-storage/upload/{test_workspace.id}/{uuid.uuid4()}/liar.bin",
        content=b"y" * (local_storage.MAX_UPLOAD_BYTES + 1),
        headers={"Content-Length": "10"},
    )
    assert_canonical(resp, status=413, error_code="payload_too_large")


async def test_traversal_path_returns_canonical_403(
    client: AsyncClient, tmp_path: Path, monkeypatch
):
    """`~` is a forbidden segment that survives URL normalization.

    A literal `..` is collapsed by the client/router before the handler sees
    it, so it never reaches the guard — `~` exercises the same branch.
    """
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.get("/api/local-storage/download/~/secrets.txt")
    assert_canonical(resp, status=403, error_code="forbidden")


async def test_missing_file_returns_canonical_404(
    client: AsyncClient, tmp_path: Path, test_workspace: Workspace, monkeypatch
):
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path))

    resp = await client.get(
        f"/api/local-storage/download/{test_workspace.id}/{uuid.uuid4()}/nope.txt"
    )
    assert_canonical(resp, status=404, error_code="not_found")


# --- 501 / 400: resources signed-url routes ---------------------------------


async def _create_resource(client: AsyncClient, url: str, **extra) -> dict:
    resp = await client.post(url, json={"name": "spec.pdf", "resource_type": "file", **extra})
    assert resp.status_code == 201
    return resp.json()


async def _create_folder(client: AsyncClient, url: str) -> dict:
    resp = await client.post(url, json={"name": "Designs", "resource_type": "folder"})
    assert resp.status_code == 201
    return resp.json()


async def test_workspace_upload_url_without_gcs_credentials_returns_canonical_501(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    """Bucket configured but credentials unavailable — the signer returns None."""
    monkeypatch.setattr(settings, "GCS_BUCKET", "some-bucket")
    monkeypatch.setattr(
        "app.services.gcs.GCSService.generate_upload_url", lambda *a, **k: None
    )

    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/resources/upload-url",
        json={"filename": "spec.pdf", "content_type": "application/pdf"},
    )
    assert_canonical(resp, status=501, error_code="storage_unavailable")


async def test_workspace_download_url_without_file_returns_canonical_400(
    client: AsyncClient, test_workspace: Workspace
):
    """A folder carries no `gcs_path` — a `file` gets one generated on create."""
    resource = await _create_folder(
        client, f"/api/workspaces/{test_workspace.slug}/resources"
    )

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/resources/{resource['id']}/download-url"
    )
    assert_canonical(resp, status=400, error_code="bad_request")


async def test_workspace_download_url_without_gcs_credentials_returns_canonical_501(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    resource = await _create_resource(
        client,
        f"/api/workspaces/{test_workspace.slug}/resources",
        gcs_path=f"{test_workspace.id}/{uuid.uuid4()}/spec.pdf",
    )
    monkeypatch.setattr(settings, "GCS_BUCKET", "some-bucket")
    monkeypatch.setattr(
        "app.services.gcs.GCSService.generate_download_url", lambda *a, **k: None
    )

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/resources/{resource['id']}/download-url"
    )
    assert_canonical(resp, status=501, error_code="storage_unavailable")


async def test_board_upload_url_without_gcs_credentials_returns_canonical_501(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, monkeypatch
):
    monkeypatch.setattr(settings, "GCS_BUCKET", "some-bucket")
    monkeypatch.setattr(
        "app.services.gcs.GCSService.generate_upload_url", lambda *a, **k: None
    )

    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        "/resources/upload-url",
        json={"filename": "spec.pdf", "content_type": "application/pdf"},
    )
    assert_canonical(resp, status=501, error_code="storage_unavailable")


async def test_board_download_url_without_file_returns_canonical_400(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    base = f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}/resources"
    resource = await _create_folder(client, base)

    resp = await client.get(f"{base}/{resource['id']}/download-url")
    assert_canonical(resp, status=400, error_code="bad_request")


async def test_board_download_url_without_gcs_credentials_returns_canonical_501(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, monkeypatch
):
    base = f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}/resources"
    resource = await _create_resource(
        client, base, gcs_path=f"{test_workspace.id}/{uuid.uuid4()}/spec.pdf"
    )
    monkeypatch.setattr(settings, "GCS_BUCKET", "some-bucket")
    monkeypatch.setattr(
        "app.services.gcs.GCSService.generate_download_url", lambda *a, **k: None
    )

    resp = await client.get(f"{base}/{resource['id']}/download-url")
    assert_canonical(resp, status=501, error_code="storage_unavailable")


# --- 422/400: bundle import speaks one shape --------------------------------


async def _seed_pipeline(client: AsyncClient, ws: Workspace) -> None:
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    resp = await client.patch(
        f"/api/workspaces/{ws.slug}/config",
        json={"pipeline_config": DEFAULT_PIPELINE_CONFIG},
    )
    assert resp.status_code == 200


async def test_bundle_import_non_object_raises_canonical_bad_request(db_session):
    """The non-dict guard is service-level only.

    Over HTTP the route's `dict[str, Any]` body annotation rejects a JSON array
    with FastAPI's own request-validation 422, so this branch is unreachable
    through the router — it defends direct service callers (MCP, scripts).
    """
    from app.exceptions import BadRequestError
    from app.services.export.pipeline_bundle import PipelineBundleService

    with pytest.raises(BadRequestError) as exc:
        PipelineBundleService(db_session)._guard_envelope([])

    assert exc.value.status_code == 400
    assert exc.value.error_code == "bad_request"


async def test_bundle_import_bad_schema_version_returns_canonical_400(
    client: AsyncClient, test_workspace: Workspace
):
    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/import",
        json={"schema_version": 999, "entity_type": "pipeline_bundle", "data": {}},
        params={"dry_run": False},
    )
    assert_canonical(resp, status=400, error_code="bad_request")


async def test_bundle_import_missing_team_returns_canonical_422(
    client: AsyncClient, test_workspace: Workspace
):
    """The missing-team 422 must match the pipeline-validation 422's shape.

    One endpoint emitted two different 422 bodies: the taxonomy `ValidationError`
    for pipeline errors, and a bare HTTPException here.
    """
    await _seed_pipeline(client, test_workspace)
    export = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/export"
    )
    assert export.status_code == 200
    bundle = export.json()
    bundle["data"]["prompt_configs"] = [
        {
            "slug": "orphan",
            "role": "orchestrator",
            "team_slug": "team-that-does-not-exist",
            "prompt_template": "hi",
        }
    ]

    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/import",
        json=bundle,
        params={"dry_run": False},
    )
    assert resp.status_code == 422
    assert set(resp.json()) == CANONICAL_KEYS, f"non-canonical body: {resp.json()}"
    assert resp.json()["error_code"] == "validation_error"


# --- 409: stale optimistic-concurrency version ------------------------------


async def test_stale_expected_version_returns_canonical_409(
    client: AsyncClient, test_workspace: Workspace
):
    """`error_code` carries the branch signal; the shape matches every other error.

    The hand-built `{"code": ..., "current_version": ...}` detail dict was a
    third 409 body shape. `ConflictError(..., error_code="stale_version")` is
    the in-repo precedent (see `BoardService.update_loop_config`).
    """
    first = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 7},
    )
    assert first.status_code == 200
    stale_version = first.json()["version"]

    bump = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 8},
    )
    assert bump.status_code == 200
    assert bump.json()["version"] != stale_version

    resp = await client.patch(
        f"/api/workspaces/{test_workspace.slug}/config",
        json={"max_rework_attempts": 99, "expected_version": stale_version},
    )
    current_version = bump.json()["version"]
    assert_canonical(
        resp,
        status=409,
        error_code="stale_version",
        context={
            "current_version": current_version,
            "expected_version": stale_version,
        },
    )
    # The versions stay legible to a human reading the message.
    assert str(stale_version) in resp.json()["detail"]
