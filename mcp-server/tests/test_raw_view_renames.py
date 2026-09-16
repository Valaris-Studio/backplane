# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The raw views get an explicit suffix: get_board_loop_binding →
get_board_loop_binding_raw (vs get_board_loop, the effective config) and
list_skill_bindings → list_skill_bindings_raw (vs list_skills(board_id), the
effective set). The old names stay as deprecated aliases."""

from __future__ import annotations

import json

import pytest

from valaris_mcp.catalog import TOOL_META, deprecated_aliases
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio


def test_raw_view_aliases_point_at_the_suffixed_names():
    aliases = deprecated_aliases()
    assert aliases["get_board_loop_binding"] == "get_board_loop_binding_raw"
    assert aliases["list_skill_bindings"] == "list_skill_bindings_raw"


def test_suffixed_raw_views_keep_their_category_and_read_kind():
    assert TOOL_META["get_board_loop_binding_raw"].category == "loop-templates"
    assert TOOL_META["get_board_loop_binding_raw"].kind == "read"
    assert TOOL_META["list_skill_bindings_raw"].category == "skills"
    assert TOOL_META["list_skill_bindings_raw"].kind == "read"


@pytest.mark.parametrize(
    ("name", "effective"),
    [("get_board_loop_binding_raw", "get_board_loop"), ("list_skill_bindings_raw", "list_skills")],
)
def test_raw_view_descriptions_open_by_saying_raw_and_name_the_effective_view(name: str, effective: str):
    description = mcp._tool_manager._tools[name].description
    first_line = description.splitlines()[0]
    assert first_line.lower().startswith("raw view"), first_line
    assert effective in description


async def test_get_board_loop_binding_raw_reads_the_binding_and_optional_diff(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_board_loop_binding_raw

    mock_client.get.side_effect = [{"template": "t", "diff_available": True}, {"prompt_diff": "x"}]
    out = json.loads(await get_board_loop_binding_raw("ws", "b1", include_diff=True, ctx=ctx))
    assert [call.args[0] for call in mock_client.get.call_args_list] == [
        "/workspaces/ws/boards/b1/loop/binding",
        "/workspaces/ws/boards/b1/loop/binding/diff",
    ]
    assert out["diff"] == {"prompt_diff": "x"}


async def test_get_board_loop_binding_alias_stamps_deprecation(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_board_loop_binding

    mock_client.get.return_value = {"template": "t", "diff_available": False}
    out = json.loads(await get_board_loop_binding("ws", "b1", ctx=ctx))
    assert out["template"] == "t"
    assert "get_board_loop_binding_raw" in out["_deprecated"]


async def test_list_skill_bindings_raw_lists_rows_with_the_effective_hint(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skill_bindings_raw

    mock_client.get.return_value = {"bindings": [{"skill_id": "s1", "enabled": False}]}
    out = json.loads(await list_skill_bindings_raw("ws", "b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/ws/boards/b1/skills/bindings")
    assert out["count"] == 1
    assert "list_skills" in out["_hint"]


async def test_list_skill_bindings_alias_stamps_deprecation(mock_client, ctx):
    from valaris_mcp.tools.skills import list_skill_bindings

    mock_client.get.return_value = {"bindings": []}
    out = json.loads(await list_skill_bindings("ws", "b1", ctx=ctx))
    assert out["count"] == 0
    assert "list_skill_bindings_raw" in out["_deprecated"]


def test_server_instructions_use_the_suffixed_names_only():
    text = mcp.instructions
    assert "get_board_loop_binding_raw" in text and "list_skill_bindings_raw" in text
    assert "get_board_loop_binding " not in text and "get_board_loop_binding." not in text
    assert "list_skill_bindings " not in text and "list_skill_bindings." not in text
