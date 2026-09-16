# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""get_loop_template(view=full|profile|preview|fit|lint) folds the five
loop-template reads; the four folded names stay as deprecated aliases."""

from __future__ import annotations

import json

import pytest

from valaris_mcp.catalog import TOOL_META, deprecated_aliases
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio


def test_loop_template_read_aliases_point_at_views():
    aliases = deprecated_aliases()
    assert aliases["get_loop_template_profile"] == "get_loop_template(view='profile')"
    assert aliases["preview_loop_template"] == "get_loop_template(view='preview')"
    assert aliases["check_loop_template_fit"] == "get_loop_template(view='fit', board_id=...)"
    assert aliases["lint_loop_template"] == "get_loop_template(view='lint')"


def test_get_loop_template_stays_a_read_and_documents_every_view():
    assert TOOL_META["get_loop_template"].kind == "read"
    props = mcp._tool_manager._tools["get_loop_template"].parameters["properties"]
    assert props["view"].get("default") == "full"
    for view in ("full", "profile", "preview", "fit", "lint"):
        assert view in props["view"]["description"], view
    for extra in ("board_id", "slot_values", "include_prompts"):
        assert extra in props, extra


async def test_full_view_is_the_default_and_unchanged(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.get.return_value = {"slug": "coding-loop", "prompts": {}}
    out = json.loads(await get_loop_template("ws", "coding-loop", draft=True, ctx=ctx))
    mock_client.get.assert_called_once_with(
        "/workspaces/ws/loop-templates/coding-loop", draft=True, include_archived=False
    )
    assert out["slug"] == "coding-loop"


async def test_profile_view_reads_the_profile_endpoint(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.get.return_value = {"boards_using": 2}
    out = json.loads(await get_loop_template("ws", "coding-loop", view="profile", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/ws/loop-templates/coding-loop/profile")
    assert out["boards_using"] == 2


async def test_preview_view_posts_slot_values_workspace_or_board_scoped(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.post.return_value = {"system_prompt": "S", "loop_prompt": "L", "findings": []}
    await get_loop_template("ws", "t1", view="preview", slot_values={"repo": "x"}, ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/ws/loop-templates/t1/preview", {"slot_values": {"repo": "x"}}
    )
    mock_client.post.reset_mock()
    out = json.loads(
        await get_loop_template("ws", "t1", view="preview", board_id="b1", include_prompts=False, ctx=ctx)
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/ws/boards/b1/loop-templates/t1/preview", {"slot_values": {}}
    )
    assert "system_prompt" not in out and "loop_prompt" not in out
    assert "_hint" in out


async def test_fit_view_requires_board_id_and_hints_fixable_checks(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    missing = json.loads(await get_loop_template("ws", "t1", view="fit", ctx=ctx))
    assert missing["error"] is True and "board_id" in missing["message"]
    mock_client.get.assert_not_called()

    mock_client.get.return_value = {"checks": [{"status": "missing", "fix_id": "f1"}]}
    out = json.loads(await get_loop_template("ws", "t1", view="fit", board_id="b1", ctx=ctx))
    mock_client.get.assert_called_once_with("/workspaces/ws/boards/b1/loop-templates/t1/fit")
    assert "apply_loop_template_fixes" in out["_hint"]


async def test_lint_view_posts_to_lint(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.post.return_value = {"findings": []}
    out = json.loads(await get_loop_template("ws", "t1", view="lint", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces/ws/loop-templates/t1/lint", {})
    assert out["findings"] == []


async def test_unknown_view_is_rejected_before_any_request(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    out = json.loads(await get_loop_template("ws", "t1", view="diff", ctx=ctx))
    assert out["error"] is True
    for view in ("full", "profile", "preview", "fit", "lint"):
        assert view in out["message"]
    mock_client.get.assert_not_called()
    mock_client.post.assert_not_called()


async def test_view_specific_params_outside_their_view_are_rejected(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    out = json.loads(await get_loop_template("ws", "t1", slot_values={"a": 1}, ctx=ctx))
    assert out["error"] is True and "preview" in out["message"]
    out = json.loads(await get_loop_template("ws", "t1", view="profile", board_id="b1", ctx=ctx))
    assert out["error"] is True and "board_id" in out["message"]
    mock_client.get.assert_not_called()


@pytest.mark.parametrize(
    ("alias", "kwargs", "method"),
    [
        ("get_loop_template_profile", {"ref": "t1"}, "get"),
        ("preview_loop_template", {"template_ref": "t1"}, "post"),
        ("check_loop_template_fit", {"board_id": "b1", "template_ref": "t1"}, "get"),
        ("lint_loop_template", {"template_ref": "t1"}, "post"),
    ],
)
async def test_folded_aliases_still_answer_and_stamp(mock_client, ctx, alias, kwargs, method):
    import valaris_mcp.tools.loop_templates as module

    getattr(mock_client, method).return_value = {"ok": True, "checks": []}
    out = json.loads(await getattr(module, alias)("ws", **kwargs, ctx=ctx))
    assert out["ok"] is True
    assert "get_loop_template(view=" in out["_deprecated"]


def test_server_instructions_teach_views_and_drop_the_five_name_rule():
    text = mcp.instructions
    assert "get_loop_template(view=" in text
    for old in ("get_loop_template_profile", "preview_loop_template", "check_loop_template_fit", "lint_loop_template"):
        assert old not in text, old
