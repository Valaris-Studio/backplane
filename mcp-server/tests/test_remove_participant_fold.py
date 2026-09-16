# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""remove_card_participants_by_role folds into
remove_card_participant(pipeline_role=...); the old name stays as a
deprecated alias (the runner dispatch table and stored pipeline configs
still name it)."""

from __future__ import annotations

import json

import pytest

from valaris_mcp.catalog import TOOL_META, deprecated_aliases, tool_annotations
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio


def test_by_role_alias_points_at_the_pipeline_role_parameter():
    assert deprecated_aliases()["remove_card_participants_by_role"] == (
        "remove_card_participant(pipeline_role=...)"
    )


def test_remove_card_participant_is_idempotent_now_that_role_clears_are_folded_in():
    meta = TOOL_META["remove_card_participant"]
    annotations = tool_annotations("remove_card_participant", meta)
    assert annotations.destructiveHint is True
    assert annotations.idempotentHint is True


def test_remove_card_participant_schema_makes_user_id_optional_and_adds_pipeline_role():
    schema = mcp._tool_manager._tools["remove_card_participant"].parameters
    assert "user_id" not in schema.get("required", [])
    assert "pipeline_role" in schema["properties"]
    assert "user_id" in schema["properties"]["pipeline_role"]["description"]


async def test_remove_by_user_id_keeps_the_participant_route(mock_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participant

    mock_client.delete.return_value = None
    out = await remove_card_participant("ws", "b1", "11111111-1111-1111-1111-111111111111", user_id="u1", ctx=ctx)
    mock_client.delete.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/11111111-1111-1111-1111-111111111111/participants/u1"
    )
    assert "u1" in out


async def test_remove_by_pipeline_role_hits_the_by_role_route(mock_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participant

    mock_client.delete.return_value = None
    out = await remove_card_participant(
        "ws", "b1", "11111111-1111-1111-1111-111111111111", pipeline_role="implementer", ctx=ctx
    )
    mock_client.delete.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/11111111-1111-1111-1111-111111111111/participants/by-pipeline-role/implementer"
    )
    assert "implementer" in out


async def test_remove_requires_exactly_one_selector(mock_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participant

    neither = json.loads(await remove_card_participant("ws", "b1", "11111111-1111-1111-1111-111111111111", ctx=ctx))
    assert neither["error"] is True and "user_id" in neither["message"] and "pipeline_role" in neither["message"]
    both = json.loads(
        await remove_card_participant(
            "ws", "b1", "11111111-1111-1111-1111-111111111111", user_id="u1", pipeline_role="reviewer", ctx=ctx
        )
    )
    assert both["error"] is True
    mock_client.delete.assert_not_called()


async def test_by_role_alias_still_clears_and_stamps(mock_client, ctx):
    from valaris_mcp.tools.cards import remove_card_participants_by_role

    mock_client.delete.return_value = None
    out = await remove_card_participants_by_role("ws", "b1", "c1", "implementer", ctx=ctx)
    mock_client.delete.assert_called_once_with(
        "/workspaces/ws/boards/b1/cards/c1/participants/by-pipeline-role/implementer"
    )
    assert "DEPRECATED" in out and "remove_card_participant(pipeline_role=" in out


def test_server_instructions_teach_the_pipeline_role_parameter():
    text = mcp.instructions
    assert "remove_card_participants_by_role" not in text
    assert "remove_card_participant(pipeline_role=" in text
