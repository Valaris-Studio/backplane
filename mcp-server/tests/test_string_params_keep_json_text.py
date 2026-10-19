# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A string-typed tool param keeps JSON-looking text as text.

FastMCP's pre_parse_json decodes a JSON string for every param not annotated
exactly `str`, so `str | None` params turned ProseMirror JSON into a dict and
failed validation ("Input should be a valid string").
"""

from __future__ import annotations

import json
from types import UnionType
from typing import Any, Union, get_args, get_origin

import pytest
from pydantic import TypeAdapter

from valaris_mcp.server import mcp

JSON_LOOKING_TEXT = [
    '{"type":"doc","content":[{"type":"paragraph"}]}',
    '["a", "b"]',
    "true",
    "null",
]


def _admits_str(annotation: Any) -> bool:
    if get_origin(annotation) in (Union, UnionType):
        return str in get_args(annotation)
    return annotation is str


def _string_params() -> list[tuple[str, str, Any]]:
    return [
        (tool.name, name, field.annotation)
        for tool in mcp._tool_manager.list_tools()
        for name, field in tool.fn_metadata.arg_model.model_fields.items()
        if _admits_str(field.annotation)
    ]


def _structured_params() -> list[tuple[str, str, Any]]:
    structured = (list, dict)
    params = []
    for tool in mcp._tool_manager.list_tools():
        for name, field in tool.fn_metadata.arg_model.model_fields.items():
            members = get_args(field.annotation) or (field.annotation,)
            if any(getattr(member, "__origin__", member) in structured for member in members):
                params.append((tool.name, name, field.annotation))
    return params


def test_surface_has_optional_string_params_to_sweep():
    # Guards the sweep below against silently testing nothing.
    optional = [p for p in _string_params() if p[2] is not str]
    assert len(optional) > 100


@pytest.mark.parametrize("text", JSON_LOOKING_TEXT)
def test_every_string_param_keeps_json_text_verbatim(text):
    tools = {tool.name: tool for tool in mcp._tool_manager.list_tools()}
    mangled = []
    for tool_name, param, annotation in _string_params():
        pre_parsed = tools[tool_name].fn_metadata.pre_parse_json({param: text})[param]
        if pre_parsed != text:
            mangled.append(f"{tool_name}.{param}")
            continue
        TypeAdapter(annotation).validate_python(pre_parsed)
    assert mangled == []


def test_list_and_dict_params_still_accept_json_text():
    tools = {tool.name: tool for tool in mcp._tool_manager.list_tools()}
    params = _structured_params()
    assert params
    for tool_name, param, annotation in params:
        sample = "[]" if "list" in str(annotation) else "{}"
        pre_parsed = tools[tool_name].fn_metadata.pre_parse_json({param: sample})[param]
        assert pre_parsed == json.loads(sample), f"{tool_name}.{param}"


@pytest.mark.anyio
async def test_update_note_accepts_prosemirror_json_string_through_the_tool(mock_client, ctx):
    prosemirror = json.dumps({"type": "doc", "content": [{"type": "paragraph"}]})
    mock_client.post.return_value = {"id": "n1"}

    await mcp._tool_manager._tools["update_note"].run(
        {"workspace_slug": "ws", "note_id": "n1", "content": prosemirror}, context=ctx
    )

    mock_client.post.assert_called_once_with("/workspaces/ws/notes/n1/edit", {"mode": "replace", "content": prosemirror})


@pytest.mark.anyio
async def test_update_card_keeps_a_json_description_as_text(mock_client, ctx):
    card_id = "12345678-1234-1234-1234-123456789012"
    description = '{"steps": ["a", "b"]}'
    mock_client.patch.return_value = {"id": card_id}

    await mcp._tool_manager._tools["update_card"].run(
        {"workspace_slug": "ws", "board_id": "b1", "card_id": card_id, "description": description},
        context=ctx,
    )

    assert mock_client.patch.call_args[0][1]["description"] == description
