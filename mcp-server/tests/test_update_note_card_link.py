# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""update_note card link/unlink params (card cb54eb39).

Contract: update_note grows `card_id: str | None = None` and
`detach_card: bool = False`.
- card_id set -> PUT body carries {"card_id": "<uuid>"} (link/re-link).
- detach_card=True -> PUT body carries {"card_id": None} (explicit clear;
  the backend PUT contract distinguishes explicit null from omission).
- neither -> body has NO card_id key (existing link untouched).
- both passed -> detach_card wins (body card_id is None).
"""

from __future__ import annotations

import pytest

from valaris_mcp.tools.notes import update_note


@pytest.mark.anyio
async def test_update_note_card_id_included_in_put_body(mock_client, ctx):
    mock_client.put.return_value = {"id": "n1", "card_id": "card-uuid-1"}
    await update_note("test", "n1", board_id="b1", card_id="card-uuid-1", ctx=ctx)
    path, body = mock_client.put.call_args[0]
    assert path == "/workspaces/test/boards/b1/notes/n1"
    assert body["card_id"] == "card-uuid-1"


@pytest.mark.anyio
async def test_update_note_detach_card_sends_explicit_null(mock_client, ctx):
    mock_client.put.return_value = {"id": "n1", "card_id": None}
    await update_note("test", "n1", board_id="b1", detach_card=True, ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert "card_id" in body
    assert body["card_id"] is None


@pytest.mark.anyio
async def test_update_note_default_omits_card_id_key(mock_client, ctx):
    # Omission preserves any existing link — the None-filter behavior of the
    # other fields must NOT swallow an unset card_id into an explicit null.
    mock_client.put.return_value = {"id": "n1"}
    await update_note("test", "n1", title="Renamed", ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"title": "Renamed"}
    assert "card_id" not in body


@pytest.mark.anyio
async def test_update_note_detach_card_wins_over_card_id(mock_client, ctx):
    mock_client.put.return_value = {"id": "n1", "card_id": None}
    await update_note(
        "test", "n1", board_id="b1", card_id="card-uuid-1", detach_card=True, ctx=ctx
    )
    body = mock_client.put.call_args[0][1]
    assert body["card_id"] is None


@pytest.mark.anyio
async def test_update_note_card_id_composes_with_other_fields(mock_client, ctx):
    mock_client.put.return_value = {"id": "n1"}
    await update_note("test", "n1", title="T", card_id="card-uuid-1", ctx=ctx)
    body = mock_client.put.call_args[0][1]
    assert body == {"title": "T", "card_id": "card-uuid-1"}
