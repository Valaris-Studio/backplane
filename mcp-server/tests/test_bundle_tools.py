# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS2: MCP tool tests for export_pipeline_bundle / import_pipeline_bundle."""

from __future__ import annotations

import json

import httpx
import pytest


def _sample_bundle() -> dict:
    return {
        "schema_version": 1,
        "entity_type": "pipeline_bundle",
        "source_workspace_slug": "acme",
        "data": {
            "pipeline_config": {"stages": [{"role": "implementer"}]},
            "pipeline_version": 3,
            "description": {"version": 1, "columns": [], "labels": []},
            "prompt_configs": [],
            "expected_pipeline_version": None,
        },
    }


@pytest.mark.anyio
async def test_export_pipeline_bundle(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import export_pipeline_bundle

    mock_client.get.return_value = _sample_bundle()
    result = json.loads(await export_pipeline_bundle("acme", ctx=ctx))

    mock_client.get.assert_called_once_with("/workspaces/acme/config/bundle/export")
    assert result["entity_type"] == "pipeline_bundle"
    assert result["data"]["pipeline_config"]["stages"]


@pytest.mark.anyio
async def test_import_pipeline_bundle_dry_run_default(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import import_pipeline_bundle

    mock_client.post.return_value = {
        "dry_run": True,
        "validation": {"pipeline_errors": []},
        "preview": {"prompts": {"created": [], "updated": [], "skipped": []}},
    }
    result = json.loads(
        await import_pipeline_bundle("acme", _sample_bundle(), ctx=ctx)
    )

    sent_path, sent_body = mock_client.post.call_args[0]
    assert sent_path == "/workspaces/acme/config/bundle/import?dry_run=true"
    assert sent_body["entity_type"] == "pipeline_bundle"
    assert result["dry_run"] is True
    assert "_hint" in result


@pytest.mark.anyio
async def test_import_pipeline_bundle_commit(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import import_pipeline_bundle

    mock_client.post.return_value = {"dry_run": False, "validation": {}, "preview": {}}
    await import_pipeline_bundle("acme", _sample_bundle(), dry_run=False, ctx=ctx)

    sent_path, _ = mock_client.post.call_args[0]
    assert sent_path == "/workspaces/acme/config/bundle/import?dry_run=false"


@pytest.mark.anyio
async def test_import_pipeline_bundle_passes_through_error(mock_client, ctx):
    from valaris_mcp.tools.workspace_config import import_pipeline_bundle

    resp = httpx.Response(
        400,
        json={"detail": "expected entity_type 'pipeline_bundle', got 'pipeline'"},
        request=httpx.Request("POST", "http://test"),
    )
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "Bad Request", request=resp.request, response=resp
    )
    raw = await import_pipeline_bundle("acme", {"entity_type": "pipeline"}, ctx=ctx)
    result = json.loads(raw)
    assert result.get("error") is True
