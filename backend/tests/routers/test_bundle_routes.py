# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""WS2: HTTP-level tests for the config-bundle export/import routes."""

from __future__ import annotations

from httpx import AsyncClient

from app.models.workspace import Workspace


async def _seed_pipeline(client: AsyncClient, ws: Workspace) -> None:
    """PATCH the default pipeline onto the workspace via the config route."""
    from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG

    resp = await client.patch(
        f"/api/workspaces/{ws.slug}/config",
        json={"pipeline_config": DEFAULT_PIPELINE_CONFIG},
    )
    assert resp.status_code == 200


async def test_export_bundle_returns_attachment(
    client: AsyncClient, test_workspace: Workspace
):
    await _seed_pipeline(client, test_workspace)
    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/export"
    )
    assert resp.status_code == 200
    assert "attachment" in resp.headers.get("content-disposition", "")
    assert "bundle.json" in resp.headers.get("content-disposition", "")
    body = resp.json()
    assert body["entity_type"] == "pipeline_bundle"
    assert body["data"]["pipeline_config"]["stages"]
    assert body["data"]["description"]["columns"]


async def test_import_bundle_dry_run_default(
    client: AsyncClient, test_workspace: Workspace
):
    await _seed_pipeline(client, test_workspace)
    export = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/export"
    )
    bundle = export.json()

    # No dry_run query param → defaults to dry-run (mutates nothing).
    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/import",
        json=bundle,
    )
    assert resp.status_code == 200
    result = resp.json()
    assert result["dry_run"] is True
    assert "prompts" in result["preview"]


async def test_import_bundle_commit(
    client: AsyncClient, test_workspace: Workspace
):
    await _seed_pipeline(client, test_workspace)
    export = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/export"
    )
    bundle = export.json()
    bundle["data"]["prompt_configs"].append(
        {
            "slug": "imported-prompt",
            "name": "Imported",
            "agent_type": None,
            "team_role": "planner",
            "stage": "plan",
            "content": "imported body",
            "team_slug": None,
            "is_system": False,
            "version": 1,
        }
    )

    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/import?dry_run=false",
        json=bundle,
    )
    assert resp.status_code == 200
    assert resp.json()["dry_run"] is False

    # The imported prompt now shows up in the prompt-config list.
    listing = await client.get(
        f"/api/workspaces/{test_workspace.slug}/prompt-configs"
    )
    assert listing.status_code == 200
    slugs = {c["slug"] for c in listing.json()}
    assert "imported-prompt" in slugs


async def test_import_bundle_invalid_pipeline_422(
    client: AsyncClient, test_workspace: Workspace
):
    await _seed_pipeline(client, test_workspace)
    export = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/export"
    )
    bundle = export.json()
    bundle["data"]["pipeline_config"]["stages"].append({"role": "broken"})

    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/import?dry_run=false",
        json=bundle,
    )
    assert resp.status_code == 422


async def test_import_bundle_wrong_entity_type_400(
    client: AsyncClient, test_workspace: Workspace
):
    await _seed_pipeline(client, test_workspace)
    export = await client.get(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/export"
    )
    bundle = export.json()
    bundle["entity_type"] = "pipeline"

    resp = await client.post(
        f"/api/workspaces/{test_workspace.slug}/config/bundle/import",
        json=bundle,
    )
    assert resp.status_code == 400
