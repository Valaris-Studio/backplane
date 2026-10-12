# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

import pytest


STORED_NOTE = {
    "id": "n1",
    "title": "Title",
    "card_id": None,
    "kind": "user_note",
    "pinned": False,
    "updated_at": "2026-10-05T00:00:00Z",
    "content": '{"type":"doc","content":[]}',
}


async def _write_note(mock_client, ctx, mode, **flags):
    from valaris_mcp.tools.notes import create_note, update_note

    mock_client.post.return_value = STORED_NOTE.copy()
    mock_client.put.return_value = STORED_NOTE.copy()
    if mode == "create":
        raw = await create_note("ws", "Title", content="body", ctx=ctx, **flags)
    else:
        section = {"anchor_heading": "Heading"} if mode == "section" else {}
        raw = await update_note("ws", "n1", content="body", mode=mode, ctx=ctx, **section, **flags)
    return json.loads(raw)


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["create", "replace", "append", "section"])
async def test_note_receipt_omits_the_body_by_default(mock_client, ctx, mode):
    result = await _write_note(mock_client, ctx, mode)

    assert "content" not in result
    assert result["content_chars"] == len(STORED_NOTE["content"])
    for field in ("id", "title", "card_id", "kind", "pinned", "updated_at"):
        assert result[field] == STORED_NOTE[field]
    assert "return_content=True" in result["_hint"]
    assert 'get_note(format="markdown")' in result["_hint"]


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["create", "replace", "append", "section"])
async def test_note_receipt_return_content_names_raw_format_and_editable_read(mock_client, ctx, mode):
    result = await _write_note(mock_client, ctx, mode, return_content=True)

    assert result["content"] == STORED_NOTE["content"]
    assert result["content_chars"] == len(STORED_NOTE["content"])
    assert result["_content_format"] == "prosemirror"
    assert 'get_note(format="markdown")' in result["_hint"]


@pytest.mark.anyio
async def test_deprecated_note_write_aliases_return_the_summary_receipt(mock_client, ctx):
    from valaris_mcp.tools.notes import append_note, replace_note_section

    mock_client.post.return_value = STORED_NOTE.copy()
    for raw in (
        await append_note("ws", "n1", "body", ctx=ctx),
        await replace_note_section("ws", "n1", "Heading", "body", ctx=ctx),
    ):
        result = json.loads(raw)
        assert "content" not in result
        assert result["content_chars"] == len(STORED_NOTE["content"])


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["create", "update", "bulk"])
async def test_card_receipt_names_raw_description_format(mock_client, ctx, operation):
    from valaris_mcp.tools.bulk import bulk_create_cards
    from valaris_mcp.tools.cards import create_card, update_card

    content = '{"type":"doc","content":[]}'
    card = {"id": "aaaaaaaa-0000-4000-8000-00000000000c", "description": content}
    mock_client.post.return_value = card.copy()
    mock_client.patch.return_value = card.copy()
    if operation == "bulk":
        mock_client.post.return_value = {"created": 1, "cards": [card]}
        result = json.loads(
            await bulk_create_cards("ws", "b1", [{"title": "T", "column_id": "c1"}], ctx=ctx)
        )
        assert result["cards"][0]["description"] == content
    elif operation == "create":
        result = json.loads(await create_card("ws", "b1", "c1", "T", ctx=ctx))
        assert result["description"] == content
    else:
        result = json.loads(await update_card("ws", "b1", card["id"], description="body", ctx=ctx))
        assert result["description"] == content
    assert result["_description_format"] == "prosemirror"
    assert "get_card" in result["_hint"]
