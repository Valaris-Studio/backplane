# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""create_board slug pass-through (audit gap G6): explicit slug is the only

idempotency lever the backend honors — slugless creates always mint new boards.
"""

from __future__ import annotations

import json

import pytest


@pytest.mark.anyio
async def test_create_board_slug_passed_through(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1", "name": "Board", "slug": "my-board"}
    result = json.loads(await create_board("test", "Board", slug="my-board", ctx=ctx))
    body = mock_client.post.call_args[0][1]
    assert body["slug"] == "my-board"
    assert result["slug"] == "my-board"


@pytest.mark.anyio
async def test_create_board_omitted_slug_omits_field(mock_client, ctx):
    from valaris_mcp.tools.boards import create_board

    mock_client.post.return_value = {"id": "b1", "name": "Board"}
    await create_board("test", "Board", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert "slug" not in body
