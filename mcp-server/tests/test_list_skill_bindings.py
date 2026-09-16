# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import pytest

BINDINGS_RESPONSE = {
    "bindings": [
        {
            "board_id": "b1",
            "skill_slug": "pdf-tools",
            "enabled": True,
            "pinned_version": 2,
        },
        {
            "board_id": "b1",
            "skill_slug": "code-review",
            "enabled": False,
            "pinned_version": None,
        },
    ]
}


@pytest.mark.anyio
async def test_list_skill_bindings_success(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skill_bindings_raw

    mock_client.get.return_value = BINDINGS_RESPONSE
    result = json.loads(
        await list_skill_bindings_raw(workspace_slug="test", board_id="b1", ctx=ctx)
    )
    mock_client.get.assert_called_once_with(
        "/workspaces/test/boards/b1/skills/bindings"
    )
    assert result["count"] == 2
    assert result["bindings"][1]["enabled"] is False
    assert "_hint" in result


@pytest.mark.anyio
async def test_list_skill_bindings_hint_contrasts_effective_set(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skill_bindings_raw

    mock_client.get.return_value = BINDINGS_RESPONSE
    result = json.loads(
        await list_skill_bindings_raw(workspace_slug="test", board_id="b1", ctx=ctx)
    )
    assert "effective" in result["_hint"]
    assert "list_skills" in result["_hint"]


@pytest.mark.anyio
async def test_list_skill_bindings_empty(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skill_bindings_raw

    mock_client.get.return_value = {"bindings": []}
    result = json.loads(
        await list_skill_bindings_raw(workspace_slug="test", board_id="b1", ctx=ctx)
    )
    assert result["bindings"] == []
    assert result["count"] == 0
