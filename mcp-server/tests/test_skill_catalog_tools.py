# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest

CATALOG_RESPONSE = {
    "entries": [
        {
            "id": "distill-methodology",
            "name": "Distill Methodology",
            "description": "Turn a finished project into a reusable skill.",
        },
        {
            "id": "tdd-discipline",
            "name": "TDD Discipline",
            "description": "Failing test first, always.",
        },
    ]
}

ACTIVATED_SKILL_RESPONSE = {
    "id": "sk-1",
    "slug": "tdd-discipline",
    "name": "TDD Discipline",
    "latest_published_version": 1,
    "origin": "catalog",
}


@pytest.mark.anyio
async def test_list_skill_catalog_success(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skill_catalog

    mock_client.get.return_value = CATALOG_RESPONSE
    result = json.loads(await list_skill_catalog(workspace_slug="test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/skill-catalog")
    assert result["count"] == 2
    assert result["entries"][0]["id"] == "distill-methodology"
    assert "activate_catalog_skill" in result["_hint"]


@pytest.mark.anyio
async def test_activate_catalog_skill_success(mock_client, ctx):
    from valaris_mcp.tools.skills import activate_catalog_skill

    mock_client.post.return_value = ACTIVATED_SKILL_RESPONSE
    result = json.loads(
        await activate_catalog_skill(
            workspace_slug="test", catalog_id="tdd-discipline", ctx=ctx
        )
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/skill-catalog/tdd-discipline/activate"
    )
    assert result["slug"] == "tdd-discipline"
    assert "set_skill_binding" in result["_hint"]


@pytest.mark.anyio
async def test_activate_catalog_skill_agent_403_surfaced(mock_client, ctx):
    from valaris_mcp.tools.skills import activate_catalog_skill

    resp = httpx.Response(
        403,
        json={"detail": "Agent callers may not activate catalog skills"},
        request=httpx.Request("POST", "http://test"),
    )
    mock_client.post.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=resp.request, response=resp
    )
    result = json.loads(
        await activate_catalog_skill(
            workspace_slug="test", catalog_id="tdd-discipline", ctx=ctx
        )
    )
    assert result["error"] is True
    assert result["status"] == 403
