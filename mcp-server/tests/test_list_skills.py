# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest

WORKSPACE_SKILL = {
    "id": "sk-1",
    "slug": "pdf-tools",
    "name": "PDF Tools",
    "description": "Extract and merge PDFs",
    "latest_published_version": 3,
    "origin": None,
    "updated_at": "2026-08-24T00:00:00Z",
    "archived_at": None,
}


@pytest.mark.anyio
async def test_list_skills_workspace_success(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [WORKSPACE_SKILL], "count": 1}
    result = json.loads(await list_skills(workspace_slug="test", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/skills")
    assert result["count"] == 1
    assert len(result["skills"]) == 1
    assert result["skills"][0]["slug"] == "pdf-tools"
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_skills_hint_documents_self_install_recipe(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [WORKSPACE_SKILL], "count": 1}
    result = json.loads(await list_skills(workspace_slug="test", ctx=ctx))
    assert "get_skill" in result["_hint"]
    assert "skills dir" in result["_hint"]


@pytest.mark.anyio
async def test_list_skills_board_scoped_effective_set(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [WORKSPACE_SKILL], "count": 1}
    result = json.loads(await list_skills(workspace_slug="test", board_id="b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/skills")
    assert result["count"] == 1


@pytest.mark.anyio
async def test_list_skills_no_file_contents_in_listing(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [WORKSPACE_SKILL], "count": 1}
    result = json.loads(await list_skills(workspace_slug="test", ctx=ctx))
    for skill in result["skills"]:
        assert "files" not in skill
        assert "content" not in skill


@pytest.mark.anyio
async def test_list_skills_empty_hint(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [], "count": 0}
    result = json.loads(await list_skills(workspace_slug="test", ctx=ctx))
    assert result["count"] == 0
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_skills_api_error_surfaced_as_json(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    resp = httpx.Response(
        404,
        json={"detail": "Workspace not found"},
        request=httpx.Request("GET", "http://test"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    result = json.loads(await list_skills(workspace_slug="missing", ctx=ctx))
    assert result["error"] is True
    assert result["status"] == 404
    assert result["message"] == "Workspace not found"


ARCHIVED_SKILL = {
    "id": "sk-2",
    "slug": "legacy-scraper",
    "name": "Legacy Scraper",
    "description": "Archived scraping skill",
    "latest_published_version": 1,
    "origin": None,
    "updated_at": "2026-08-24T00:00:00Z",
    "archived_at": "2026-08-24T12:00:00Z",
}


@pytest.mark.anyio
async def test_list_skills_include_archived_true_appends_query_param(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {
        "skills": [WORKSPACE_SKILL, ARCHIVED_SKILL],
        "count": 2,
    }
    result = json.loads(
        await list_skills(workspace_slug="test", include_archived=True, ctx=ctx)
    )
    mock_client.get.assert_called_once_with(
        "/workspaces/test/skills?include_archived=true"
    )
    assert result["count"] == 2


@pytest.mark.anyio
async def test_list_skills_include_archived_false_omits_query_param(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [WORKSPACE_SKILL], "count": 1}
    result = json.loads(
        await list_skills(workspace_slug="test", include_archived=False, ctx=ctx)
    )
    mock_client.get.assert_called_once_with("/workspaces/test/skills")
    assert result["count"] == 1


@pytest.mark.anyio
async def test_list_skills_board_path_ignores_include_archived(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    mock_client.get.return_value = {"skills": [WORKSPACE_SKILL], "count": 1}
    result = json.loads(
        await list_skills(
            workspace_slug="test", board_id="b1", include_archived=True, ctx=ctx
        )
    )
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/skills")
    assert result["count"] == 1


@pytest.mark.anyio
async def test_list_skills_signature_orders_include_archived_before_ctx(mock_client, ctx):
    import inspect

    from valaris_mcp.tools.skills import list_skills

    params = list(inspect.signature(list_skills).parameters)
    assert params == ["workspace_slug", "board_id", "include_archived", "ctx"]
    include_archived = inspect.signature(list_skills).parameters["include_archived"]
    assert include_archived.default is False


@pytest.mark.anyio
async def test_list_skills_docstring_documents_include_archived(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skills

    assert "include_archived" in list_skills.__doc__
