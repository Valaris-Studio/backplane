# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest


@pytest.mark.anyio
async def test_remove_skill_binding_success(mock_client, ctx):
    from valaris_mcp.tools.skills import remove_skill_binding

    mock_client.delete.return_value = None
    result = json.loads(
        await remove_skill_binding(
            workspace_slug="test", board_id="b1", skill_slug="pdf-tools", ctx=ctx
        )
    )
    mock_client.delete.assert_called_once_with(
        "/workspaces/test/boards/b1/skills/pdf-tools"
    )
    assert result["removed"] is True
    assert result["skill_slug"] == "pdf-tools"


@pytest.mark.anyio
async def test_remove_skill_binding_hint_offers_disable_alternative(mock_client, ctx):
    from valaris_mcp.tools.skills import remove_skill_binding

    mock_client.delete.return_value = None
    result = json.loads(
        await remove_skill_binding(
            workspace_slug="test", board_id="b1", skill_slug="pdf-tools", ctx=ctx
        )
    )
    assert "set_skill_binding" in result["_hint"]


@pytest.mark.anyio
async def test_remove_skill_binding_api_error_surfaced_as_json(mock_client, ctx):
    from valaris_mcp.tools.skills import remove_skill_binding

    resp = httpx.Response(
        403,
        json={"detail": "Admin role required"},
        request=httpx.Request("DELETE", "http://test"),
    )
    mock_client.delete.side_effect = httpx.HTTPStatusError(
        "Forbidden", request=resp.request, response=resp
    )
    result = json.loads(
        await remove_skill_binding(
            workspace_slug="test", board_id="b1", skill_slug="pdf-tools", ctx=ctx
        )
    )
    assert result["error"] is True
    assert result["status"] == 403
