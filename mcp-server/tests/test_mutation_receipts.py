# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json

import pytest


@pytest.mark.anyio
@pytest.mark.parametrize("mode", ["create", "replace", "append", "section"])
async def test_note_receipt_names_raw_format_and_editable_read(mock_client, ctx, mode):
    from valaris_mcp.tools.notes import create_note, update_note

    content = '{"type":"doc","content":[]}'
    receipt = {"id": "n1", "content": content}
    mock_client.post.return_value = receipt.copy()
    mock_client.put.return_value = receipt.copy()
    if mode == "create":
        raw = await create_note("ws", "Title", content="body", ctx=ctx)
    else:
        kwargs = {"anchor_heading": "Heading"} if mode == "section" else {}
        raw = await update_note("ws", "n1", content="body", mode=mode, ctx=ctx, **kwargs)
    result = json.loads(raw)
    assert result["content"] == content
    assert result["_content_format"] == "prosemirror"
    assert 'get_note(format="markdown")' in result["_hint"]


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
