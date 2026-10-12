# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Signed storage URLs expire, so an agent must embed the stable,
authenticated content path in notes and only fetch with the signed one."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from valaris_mcp.tracking import CREDENTIAL_RESULT_TOOLS

RESOURCE_ID = "6f1c2a9e-0b7d-4e47-9a51-3d8c1f0e2b44"
STABLE_CONTENT_PATH = f"/api/workspaces/test/resources/{RESOURCE_ID}/content"
SIGNED_DOWNLOAD = "https://storage.googleapis.com/b/k?X-Goog-Signature=abc"


def _http_error(status: int, body: dict) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "http://test/api/workspaces/test/resources")
    response = httpx.Response(status, json=body, request=request)
    return httpx.HTTPStatusError("error", request=request, response=response)


@pytest.mark.anyio
async def test_get_download_url_passes_the_stable_content_url_through(mock_client, ctx):
    from valaris_mcp.tools.resources import get_download_url

    mock_client.get.return_value = {
        "download_url": SIGNED_DOWNLOAD,
        "content_url": STABLE_CONTENT_PATH,
        "expires_in": 3600,
    }
    result = json.loads(await get_download_url("test", RESOURCE_ID, ctx=ctx))

    assert result["download_url"] == SIGNED_DOWNLOAD
    assert result["content_url"] == STABLE_CONTENT_PATH
    assert result["expires_in"] == 3600
    assert "content_url" in result["_hint"] and "notes" in result["_hint"]


@pytest.mark.anyio
async def test_get_download_url_on_an_older_backend_invents_no_content_url(mock_client, ctx):
    from valaris_mcp.tools.resources import get_download_url

    mock_client.get.return_value = {"download_url": SIGNED_DOWNLOAD}
    result = json.loads(await get_download_url("test", RESOURCE_ID, ctx=ctx))

    assert "content_url" not in result
    assert "expires" in result["_hint"]


@pytest.mark.anyio
async def test_get_upload_url_hint_points_at_the_stable_link_create_resource_returns(mock_client, ctx):
    from valaris_mcp.tools.resources import get_upload_url

    mock_client.post.return_value = {"upload_url": SIGNED_DOWNLOAD, "gcs_path": "ws/obj/a.png"}
    result = json.loads(await get_upload_url("test", "a.png", "image/png", ctx=ctx))

    assert result["upload_url"] == SIGNED_DOWNLOAD
    assert "create_resource" in result["_hint"] and "content_url" in result["_hint"]


@pytest.mark.anyio
async def test_create_resource_for_an_upload_returns_the_stable_content_url(mock_client, ctx):
    from valaris_mcp.tools.resources import create_resource

    mock_client.post.return_value = {
        "id": RESOURCE_ID,
        "resource_type": "file",
        "gcs_path": "ws/obj/a.png",
        "mime_type": "image/png",
        "size_bytes": 12,
    }
    result = json.loads(
        await create_resource("test", "a.png", gcs_path="ws/obj/a.png", board_id="b1", ctx=ctx)
    )

    # Board-scoped or not, the workspace-level content route serves it.
    assert result["content_url"] == STABLE_CONTENT_PATH
    assert result["mime_type"] == "image/png"


@pytest.mark.anyio
async def test_create_resource_without_an_upload_has_no_content_url(mock_client, ctx):
    from valaris_mcp.tools.resources import create_resource

    mock_client.post.return_value = {"id": RESOURCE_ID, "resource_type": "folder", "gcs_path": None}
    result = json.loads(await create_resource("test", "docs", resource_type="folder", ctx=ctx))

    assert "content_url" not in result


@pytest.mark.anyio
async def test_create_resource_before_the_upload_tells_the_agent_to_put_first(mock_client, ctx):
    from valaris_mcp.tools.resources import create_resource

    mock_client.post.side_effect = _http_error(
        422,
        {
            "detail": "No uploaded object at gcs_path — upload the file first",
            "error_code": "object_not_uploaded",
        },
    )
    result = json.loads(await create_resource("test", "a.png", gcs_path="ws/obj/a.png", ctx=ctx))

    assert result["error"] is True
    assert result["status"] == 422
    assert result["error_code"] == "object_not_uploaded"
    assert "PUT" in result["_hint"] and "upload_url" in result["_hint"]


@pytest.mark.anyio
async def test_create_resource_other_errors_keep_the_generic_shape(mock_client, ctx):
    from valaris_mcp.tools.resources import create_resource

    mock_client.post.side_effect = _http_error(404, {"detail": "Board not found"})
    result = json.loads(await create_resource("test", "a.png", gcs_path="x", ctx=ctx))

    assert result == {"error": True, "status": 404, "message": "Board not found"}


def test_descriptions_name_the_stable_link_and_the_derived_file_facts():
    from valaris_mcp.tools.resources import create_resource, get_download_url

    assert "content_url" in get_download_url.__doc__.split("\n")[0]
    create_summary = create_resource.__doc__.split("\n")[0]
    assert "type and size" in create_summary


def test_signed_url_results_stay_out_of_invocation_summaries():
    assert {"get_download_url", "get_upload_url"} <= CREDENTIAL_RESULT_TOOLS


def test_092_changelog_announces_the_stable_content_url():
    text = (Path(__file__).resolve().parents[1] / "CHANGELOG.md").read_text()
    start = text.index("## [0.9.2]")
    section = text[start : text.index("## [0.9.1]", start)]
    for term in ("content_url", "get_download_url", "create_resource", "object_not_uploaded"):
        assert term in section, term
