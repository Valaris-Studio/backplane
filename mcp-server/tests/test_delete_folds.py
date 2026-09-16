# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""hard_delete_agent folds into update_agent(hard_delete=True) and
delete_webhook into update_webhook(delete=True); both old names stay as
deprecated aliases. The folding flag is the whole confirmation: it is explicit
in the call, and the fold gives the surviving tool a destructive hint."""

from __future__ import annotations

import json

import httpx
import pytest

from valaris_mcp.catalog import TOOL_META, deprecated_aliases, tool_annotations
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio


def test_delete_aliases_point_at_the_folding_flags():
    aliases = deprecated_aliases()
    assert "update_agent(hard_delete=True)" in aliases["hard_delete_agent"]
    assert "update_webhook(delete=True)" in aliases["delete_webhook"]


def test_folded_update_tools_carry_a_destructive_hint():
    for name in ("update_agent", "update_webhook"):
        annotations = tool_annotations(name, TOOL_META[name])
        assert annotations.destructiveHint is True, name
        assert annotations.idempotentHint is True, name


def test_folded_update_tools_document_the_flag():
    agent_props = mcp._tool_manager._tools["update_agent"].parameters["properties"]
    assert agent_props["hard_delete"].get("default") is False
    assert "unrecoverable" in agent_props["hard_delete"]["description"].lower()
    webhook_props = mcp._tool_manager._tools["update_webhook"].parameters["properties"]
    assert webhook_props["delete"].get("default") is False
    assert "is_active" in webhook_props["delete"]["description"]


# ---------- update_agent ----------


async def test_update_agent_without_the_flag_patches_as_before(mock_client, ctx):
    from valaris_mcp.tools.agents import update_agent

    mock_client.patch.return_value = {"id": "a1", "name": "n"}
    out = json.loads(await update_agent("a1", name="n", ctx=ctx))
    mock_client.patch.assert_called_once_with("/agents/a1", {"name": "n"})
    mock_client.delete.assert_not_called()
    assert out["name"] == "n"


async def test_update_agent_hard_delete_calls_the_hard_route_and_nothing_else(mock_client, ctx):
    from valaris_mcp.tools.agents import update_agent

    mock_client.delete.return_value = None
    out = json.loads(await update_agent("a1", hard_delete=True, ctx=ctx))
    mock_client.delete.assert_called_once_with("/agents/a1/hard")
    mock_client.patch.assert_not_called()
    assert out["deleted"] is True and out["agent_id"] == "a1"


async def test_update_agent_hard_delete_rejects_other_fields(mock_client, ctx):
    """A delete that also carries edits is a contradiction; refuse it before
    any request rather than silently dropping the edits."""
    from valaris_mcp.tools.agents import update_agent

    out = json.loads(await update_agent("a1", is_active=False, hard_delete=True, ctx=ctx))
    assert out["error"] is True and "hard_delete" in out["message"]
    mock_client.delete.assert_not_called()
    mock_client.patch.assert_not_called()


async def test_update_agent_hard_delete_surfaces_in_flight_refusal(mock_client, ctx):
    from valaris_mcp.tools.agents import update_agent

    response = httpx.Response(409, json={"detail": "card in flight", "error_code": "agent_busy"})
    mock_client.delete.side_effect = httpx.HTTPStatusError("409", request=None, response=response)
    out = json.loads(await update_agent("a1", hard_delete=True, ctx=ctx))
    assert out["error"] is True and out["status"] == 409


async def test_hard_delete_agent_alias_still_requires_confirm_and_stamps(mock_client, ctx):
    from valaris_mcp.tools.agents import hard_delete_agent

    refused = json.loads(await hard_delete_agent("a1", ctx=ctx))
    assert refused["deleted"] is False and "_deprecated" in refused
    mock_client.delete.assert_not_called()

    mock_client.delete.return_value = None
    done = json.loads(await hard_delete_agent("a1", confirm=True, ctx=ctx))
    mock_client.delete.assert_called_once_with("/agents/a1/hard")
    assert done["deleted"] is True and "update_agent" in done["_deprecated"]


# ---------- update_webhook ----------


async def test_update_webhook_without_the_flag_patches_as_before(mock_client, ctx):
    from valaris_mcp.tools.webhooks import update_webhook

    mock_client.patch.return_value = {"id": "wh-1", "is_active": False}
    out = json.loads(await update_webhook("acme", "wh-1", is_active=False, ctx=ctx))
    mock_client.patch.assert_called_once_with("/workspaces/acme/webhooks/wh-1", {"is_active": False})
    mock_client.delete.assert_not_called()
    assert out["is_active"] is False


async def test_update_webhook_delete_issues_the_delete_and_confirms(mock_client, ctx):
    from valaris_mcp.tools.webhooks import update_webhook

    mock_client.delete.return_value = None
    out = json.loads(await update_webhook("acme", "wh-1", delete=True, ctx=ctx))
    mock_client.delete.assert_called_once_with("/workspaces/acme/webhooks/wh-1")
    mock_client.patch.assert_not_called()
    assert out["deleted"] is True and out["webhook_id"] == "wh-1"


async def test_update_webhook_delete_treats_404_as_already_deleted(mock_client, ctx):
    from valaris_mcp.tools.webhooks import update_webhook

    response = httpx.Response(404, json={"detail": "not found"})
    mock_client.delete.side_effect = httpx.HTTPStatusError("404", request=None, response=response)
    out = json.loads(await update_webhook("acme", "gone", delete=True, ctx=ctx))
    assert out["deleted"] is True and "already" in out["_hint"].lower()


async def test_update_webhook_delete_rejects_other_fields(mock_client, ctx):
    from valaris_mcp.tools.webhooks import update_webhook

    out = json.loads(await update_webhook("acme", "wh-1", url="https://x", delete=True, ctx=ctx))
    assert out["error"] is True and "delete" in out["message"]
    mock_client.delete.assert_not_called()
    mock_client.patch.assert_not_called()


async def test_delete_webhook_alias_still_deletes_and_stamps(mock_client, ctx):
    from valaris_mcp.tools.webhooks import delete_webhook

    mock_client.delete.return_value = None
    out = await delete_webhook("acme", "wh-1", ctx=ctx)
    mock_client.delete.assert_called_once_with("/workspaces/acme/webhooks/wh-1")
    assert "update_webhook" in out and "DEPRECATED" in out


def test_server_instructions_point_at_the_folded_flags():
    text = mcp.instructions
    assert "hard_delete_agent" not in text
    assert "update_agent(hard_delete=" in text or "hard_delete=true" in text.lower()
