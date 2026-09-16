# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json
from unittest.mock import call

import httpx
import pytest

SKILL_DETAIL = {
    "id": "sk-1",
    "slug": "pdf-tools",
    "name": "PDF Tools",
    "description": "Extract and merge PDFs",
    "latest_published_version": 3,
    "origin": None,
    "versions": [{"version": 3, "status": "published", "content_hash": "abc"}],
}

VERSION_PAYLOAD = {
    "skill_slug": "pdf-tools",
    "version": 3,
    "status": "published",
    "files": [
        {"path": "SKILL.md", "content": "# PDF Tools\n\nUse pdftk."},
        {"path": "scripts/merge.py", "content": "print('merge')"},
    ],
    "content_hash": "abc",
}


@pytest.mark.anyio
async def test_get_skill_latest_resolves_published_version(mock_client, ctx):
    from valaris_mcp.tools.skills import get_skill

    mock_client.get.side_effect = [SKILL_DETAIL, VERSION_PAYLOAD]
    result = json.loads(await get_skill(workspace_slug="test", slug="pdf-tools", ctx=ctx))
    assert mock_client.get.call_args_list == [
        call("/workspaces/test/skills/pdf-tools"),
        call("/workspaces/test/skills/pdf-tools/versions/3"),
    ]
    assert result["version"] == 3
    assert len(result["files"]) == 2
    assert result["files"][0]["path"] == "SKILL.md"
    assert "_hint" in result


@pytest.mark.anyio
async def test_get_skill_explicit_version_single_get(mock_client, ctx):
    from valaris_mcp.tools.skills import get_skill

    mock_client.get.return_value = {**VERSION_PAYLOAD, "version": 2}
    result = json.loads(
        await get_skill(workspace_slug="test", slug="pdf-tools", version=2, ctx=ctx)
    )
    mock_client.get.assert_called_once_with("/workspaces/test/skills/pdf-tools/versions/2")
    assert result["version"] == 2
    assert len(result["files"]) == 2


@pytest.mark.anyio
async def test_get_skill_no_published_version_hint(mock_client, ctx):
    from valaris_mcp.tools.skills import get_skill

    mock_client.get.return_value = {**SKILL_DETAIL, "latest_published_version": None, "versions": []}
    result = json.loads(await get_skill(workspace_slug="test", slug="pdf-tools", ctx=ctx))
    assert "no published version" in result["_hint"]
    assert result.get("files", []) == [] or result.get("error")


@pytest.mark.anyio
async def test_get_skill_truncates_oversized_file(mock_client, ctx):
    from valaris_mcp.tools.skills import MAX_SKILL_FILE_CHARS, get_skill

    assert MAX_SKILL_FILE_CHARS == 6000
    big_content = "x" * (MAX_SKILL_FILE_CHARS + 1000)
    small_content = "# small"
    mock_client.get.return_value = {
        **VERSION_PAYLOAD,
        "files": [
            {"path": "SKILL.md", "content": big_content},
            {"path": "scripts/merge.py", "content": small_content},
        ],
    }
    result = json.loads(
        await get_skill(workspace_slug="test", slug="pdf-tools", version=3, ctx=ctx)
    )
    files = {f["path"]: f["content"] for f in result["files"]}
    assert files["SKILL.md"].endswith("… [truncated]")
    assert len(files["SKILL.md"]) < len(big_content)
    assert files["scripts/merge.py"] == small_content
    assert result["_files_truncated"] == 1
    assert "file_path" in result["_hint"]


@pytest.mark.anyio
async def test_get_skill_under_cap_no_truncation_flag(mock_client, ctx):
    from valaris_mcp.tools.skills import get_skill

    mock_client.get.return_value = VERSION_PAYLOAD
    result = json.loads(
        await get_skill(workspace_slug="test", slug="pdf-tools", version=3, ctx=ctx)
    )
    assert "_files_truncated" not in result
    files = {f["path"]: f["content"] for f in result["files"]}
    assert files["SKILL.md"] == "# PDF Tools\n\nUse pdftk."


@pytest.mark.anyio
async def test_get_skill_file_path_returns_single_full_file(mock_client, ctx):
    from valaris_mcp.tools.skills import MAX_SKILL_FILE_CHARS, get_skill

    big_content = "y" * (MAX_SKILL_FILE_CHARS + 5000)
    mock_client.get.return_value = {
        **VERSION_PAYLOAD,
        "files": [
            {"path": "SKILL.md", "content": big_content},
            {"path": "scripts/merge.py", "content": "print('merge')"},
        ],
    }
    result = json.loads(
        await get_skill(
            workspace_slug="test",
            slug="pdf-tools",
            version=3,
            file_path="SKILL.md",
            ctx=ctx,
        )
    )
    assert len(result["files"]) == 1
    assert result["files"][0]["path"] == "SKILL.md"
    assert result["files"][0]["content"] == big_content
    assert result["skill_slug"] == "pdf-tools"
    assert result["version"] == 3


@pytest.mark.anyio
async def test_get_skill_file_path_unknown_lists_available(mock_client, ctx):
    from valaris_mcp.tools.skills import get_skill

    mock_client.get.return_value = VERSION_PAYLOAD
    result = json.loads(
        await get_skill(
            workspace_slug="test",
            slug="pdf-tools",
            version=3,
            file_path="does/not/exist.md",
            ctx=ctx,
        )
    )
    assert "SKILL.md" in result["_hint"]
    assert "scripts/merge.py" in result["_hint"]
    assert result.get("files", []) == [] or result.get("error")


@pytest.mark.anyio
async def test_get_skill_api_error_surfaced_as_json(mock_client, ctx):
    from valaris_mcp.tools.skills import get_skill

    resp = httpx.Response(
        404,
        json={"detail": "Skill not found"},
        request=httpx.Request("GET", "http://test"),
    )
    mock_client.get.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    result = json.loads(await get_skill(workspace_slug="test", slug="missing", ctx=ctx))
    assert result["error"] is True
    assert result["status"] == 404
    assert result["message"] == "Skill not found"


@pytest.mark.anyio
async def test_get_skill_no_published_version_keeps_declared_toolsets(mock_client, ctx):
    # A draft-only skill still declares its hand; the "no published version"
    # shape must carry it (and the lint verdict) like the version detail does.
    from valaris_mcp.tools.skills import get_skill

    mock_client.get.return_value = {
        "id": "s1",
        "slug": "draft-only",
        "name": "Draft only",
        "description": "d",
        "latest_published_version": None,
        "origin": None,
        "toolsets": ["cards", "notes"],
        "lint_warnings": ["delete_workspace"],
    }
    result = json.loads(await get_skill("acme", "draft-only", ctx=ctx))
    assert result["skill"]["toolsets"] == ["cards", "notes"]
    assert result["skill"]["lint_warnings"] == ["delete_workspace"]
    assert result["files"] == []
