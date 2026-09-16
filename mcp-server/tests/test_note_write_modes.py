# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""update_note(mode=replace|append|section) folds the three note-write paths;
append_note and replace_note_section stay as deprecated aliases."""

from __future__ import annotations

import json

import pytest

from valaris_mcp.catalog import TOOL_META, deprecated_aliases, tool_annotations
from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio


# ---------- table ----------


def test_note_write_aliases_point_at_update_note_modes():
    aliases = deprecated_aliases()
    assert "update_note(mode='append')" in aliases["append_note"]
    assert "update_note(mode='section')" in aliases["replace_note_section"]


def test_update_note_is_no_longer_annotated_idempotent():
    # mode="append" is additive, so the tool as a whole cannot promise a
    # repeat call is a no-op.
    assert tool_annotations("update_note", TOOL_META["update_note"]).idempotentHint is False


def test_update_note_schema_carries_mode_and_anchor_heading():
    props = mcp._tool_manager._tools["update_note"].parameters["properties"]
    assert "mode" in props and "anchor_heading" in props
    assert props["mode"].get("default") == "replace"
    assert "append" in props["mode"]["description"] and "section" in props["mode"]["description"]


# ---------- replace (default) ----------


async def test_update_note_default_mode_puts_only_provided_fields(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.put.return_value = {"id": "n1"}
    await update_note("test", "n1", title="T", content="C", ctx=ctx)
    mock_client.put.assert_called_once_with("/workspaces/test/notes/n1", {"title": "T", "content": "C"})
    mock_client.post.assert_not_called()


async def test_update_note_explicit_replace_mode_is_the_default_path(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.put.return_value = {"id": "n1"}
    await update_note("test", "n1", content="C", mode="replace", board_id="b1", ctx=ctx)
    mock_client.put.assert_called_once_with("/workspaces/test/boards/b1/notes/n1", {"content": "C"})


# ---------- append ----------


async def test_update_note_append_mode_posts_content_to_append(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.post.return_value = {"id": "n1"}
    out = json.loads(await update_note("test", "n1", content="## Session 5", mode="append", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces/test/notes/n1/append", {"content": "## Session 5"})
    mock_client.put.assert_not_called()
    assert out["id"] == "n1"


async def test_update_note_append_mode_board_scoped_path(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.post.return_value = {"id": "n1"}
    await update_note("test", "n1", content="entry", mode="append", board_id="b1", ctx=ctx)
    assert mock_client.post.call_args[0][0] == "/workspaces/test/boards/b1/notes/n1/append"


async def test_update_note_append_mode_requires_content(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    out = json.loads(await update_note("test", "n1", mode="append", ctx=ctx))
    assert out["error"] is True
    assert "content" in out["message"]
    mock_client.post.assert_not_called()


async def test_update_note_append_mode_applies_metadata_first_then_appends(mock_client, ctx):
    """title/pinned/card_id still mean what they mean in every mode: they go
    through the PUT before the body operation, so one call can retitle a log
    and add today's entry."""
    from valaris_mcp.tools.notes import update_note

    mock_client.put.return_value = {"id": "n1"}
    mock_client.post.return_value = {"id": "n1", "title": "Log"}
    out = json.loads(
        await update_note("test", "n1", title="Log", pinned=True, content="entry", mode="append", ctx=ctx)
    )
    mock_client.put.assert_called_once_with("/workspaces/test/notes/n1", {"title": "Log", "pinned": True})
    mock_client.post.assert_called_once_with("/workspaces/test/notes/n1/append", {"content": "entry"})
    assert out["title"] == "Log"


# ---------- section ----------


async def test_update_note_section_mode_posts_anchor_and_content(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.post.return_value = {"id": "n1"}
    await update_note("test", "n1", content="Done.", mode="section", anchor_heading="Cluster I", ctx=ctx)
    mock_client.post.assert_called_once_with(
        "/workspaces/test/notes/n1/replace-section",
        {"anchor_heading": "Cluster I", "content": "Done."},
    )
    mock_client.put.assert_not_called()


async def test_update_note_section_mode_omitted_content_clears_the_section(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    mock_client.post.return_value = {"id": "n1"}
    await update_note("test", "n1", mode="section", anchor_heading="Cluster I", board_id="b1", ctx=ctx)
    assert mock_client.post.call_args[0][0] == "/workspaces/test/boards/b1/notes/n1/replace-section"
    assert mock_client.post.call_args[0][1] == {"anchor_heading": "Cluster I", "content": ""}


async def test_update_note_section_mode_requires_anchor_heading(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    out = json.loads(await update_note("test", "n1", content="x", mode="section", ctx=ctx))
    assert out["error"] is True
    assert "anchor_heading" in out["message"]
    mock_client.post.assert_not_called()


async def test_update_note_anchor_heading_outside_section_mode_is_rejected(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    out = json.loads(await update_note("test", "n1", content="x", anchor_heading="H", ctx=ctx))
    assert out["error"] is True
    assert "section" in out["message"]
    mock_client.put.assert_not_called()


async def test_update_note_unknown_mode_is_rejected_before_any_request(mock_client, ctx):
    from valaris_mcp.tools.notes import update_note

    out = json.loads(await update_note("test", "n1", content="x", mode="patch", ctx=ctx))
    assert out["error"] is True
    assert "replace" in out["message"] and "append" in out["message"] and "section" in out["message"]
    mock_client.put.assert_not_called()
    mock_client.post.assert_not_called()


# ---------- aliases keep their contract ----------


async def test_append_note_alias_still_posts_and_stamps_deprecation(mock_client, ctx):
    from valaris_mcp.tools.notes import append_note

    mock_client.post.return_value = {"id": "n1"}
    out = json.loads(await append_note("test", "n1", "entry", ctx=ctx))
    mock_client.post.assert_called_once_with("/workspaces/test/notes/n1/append", {"content": "entry"})
    assert "update_note" in out["_deprecated"]


async def test_replace_note_section_alias_still_posts_and_stamps_deprecation(mock_client, ctx):
    from valaris_mcp.tools.notes import replace_note_section

    mock_client.post.return_value = {"id": "n1"}
    out = json.loads(await replace_note_section("test", "n1", "Cluster I", "Done.", ctx=ctx))
    mock_client.post.assert_called_once_with(
        "/workspaces/test/notes/n1/replace-section", {"anchor_heading": "Cluster I", "content": "Done."}
    )
    assert "update_note" in out["_deprecated"]


# ---------- prose ----------


def test_server_instructions_have_no_note_write_disambiguation_rule():
    from valaris_mcp.server import mcp as server

    text = server.instructions
    assert "append_note" not in text
    assert "replace_note_section" not in text
    assert 'mode="append"' in text or "mode=append" in text
