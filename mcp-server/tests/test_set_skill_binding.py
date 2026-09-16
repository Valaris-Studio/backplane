# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import json

import httpx
import pytest

BINDING_RESPONSE = {
    "board_id": "b1",
    "skill_id": "sk-1",
    "enabled": True,
    "pinned_version": None,
    "role": None,
}


@pytest.mark.anyio
async def test_set_skill_binding_enable_success(mock_client, ctx):
    from valaris_mcp.tools.skills import set_skill_binding

    mock_client.put.return_value = BINDING_RESPONSE
    result = json.loads(
        await set_skill_binding(
            workspace_slug="test", board_id="b1", skill_slug="pdf-tools", ctx=ctx
        )
    )
    mock_client.put.assert_called_once()
    path, body = mock_client.put.call_args[0][0], mock_client.put.call_args[0][1]
    assert path == "/workspaces/test/boards/b1/skills/pdf-tools"
    # enabled is tri-state: omitted from the call, omitted on the wire — a
    # newly created binding defaults to enabled backend-side.
    assert "enabled" not in body
    assert "pinned_version" not in body
    assert "_hint" in result


@pytest.mark.anyio
async def test_set_skill_binding_pinned_version_in_body(mock_client, ctx):
    from valaris_mcp.tools.skills import set_skill_binding

    mock_client.put.return_value = {**BINDING_RESPONSE, "pinned_version": 2}
    await set_skill_binding(
        workspace_slug="test",
        board_id="b1",
        skill_slug="pdf-tools",
        pinned_version=2,
        ctx=ctx,
    )
    body = mock_client.put.call_args[0][1]
    # A pin-only call must not touch enabled — sending the old default True
    # here silently re-enabled deliberately disabled bindings.
    assert "enabled" not in body
    assert body["pinned_version"] == 2


@pytest.mark.anyio
async def test_set_skill_binding_disable(mock_client, ctx):
    from valaris_mcp.tools.skills import set_skill_binding

    mock_client.put.return_value = {**BINDING_RESPONSE, "enabled": False}
    result = json.loads(
        await set_skill_binding(
            workspace_slug="test",
            board_id="b1",
            skill_slug="pdf-tools",
            enabled=False,
            ctx=ctx,
        )
    )
    body = mock_client.put.call_args[0][1]
    assert body["enabled"] is False
    assert "pinned_version" not in body
    assert "_hint" in result


@pytest.mark.anyio
async def test_set_skill_binding_hint_mentions_next_assignment(mock_client, ctx):
    from valaris_mcp.tools.skills import set_skill_binding

    mock_client.put.return_value = BINDING_RESPONSE
    result = json.loads(
        await set_skill_binding(
            workspace_slug="test", board_id="b1", skill_slug="pdf-tools", ctx=ctx
        )
    )
    assert "next" in result["_hint"]


@pytest.mark.anyio
async def test_set_skill_binding_api_error_surfaced_as_json(mock_client, ctx):
    from valaris_mcp.tools.skills import set_skill_binding

    resp = httpx.Response(
        404,
        json={"detail": "Skill not found"},
        request=httpx.Request("PUT", "http://test"),
    )
    mock_client.put.side_effect = httpx.HTTPStatusError(
        "Not Found", request=resp.request, response=resp
    )
    result = json.loads(
        await set_skill_binding(
            workspace_slug="test", board_id="b1", skill_slug="missing", ctx=ctx
        )
    )
    assert result["error"] is True
    assert result["status"] == 404
    assert result["message"] == "Skill not found"


@pytest.mark.anyio
async def test_set_skill_binding_clear_pin_sends_explicit_null(mock_client, ctx):
    from valaris_mcp.tools.skills import set_skill_binding

    mock_client.put.return_value = BINDING_RESPONSE
    result = json.loads(
        await set_skill_binding(
            workspace_slug="test",
            board_id="b1",
            skill_slug="pdf-tools",
            clear_pin=True,
            ctx=ctx,
        )
    )
    body = mock_client.put.call_args[0][1]
    assert "pinned_version" in body
    assert body["pinned_version"] is None
    # The unpin must ride alone: carrying enabled here re-enabled disabled
    # bindings (the clear_pin re-enable bug).
    assert "enabled" not in body
    assert "_hint" in result


@pytest.mark.anyio
async def test_set_skill_binding_clear_pin_conflicts_with_pinned_version(
    mock_client, ctx
):
    from valaris_mcp.tools.skills import set_skill_binding

    result = json.loads(
        await set_skill_binding(
            workspace_slug="test",
            board_id="b1",
            skill_slug="pdf-tools",
            pinned_version=2,
            clear_pin=True,
            ctx=ctx,
        )
    )
    assert result["error"] is True
    assert "clear_pin" in result["message"]
    mock_client.put.assert_not_called()
