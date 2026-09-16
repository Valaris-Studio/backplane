# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""get_card must read card descriptions as faithful markdown (editor P0-3).

Once the backend normalizes card descriptions to canonical ProseMirror JSON,
the default GET returns that JSON — unreadable ballast for agents. get_card
must request `format=markdown` so agents keep reading faithful markdown.
test_tools.py::test_get_card pins the same expectation on the exact path.
"""
from __future__ import annotations

import json

import pytest

CARD_UUID = "aaaaaaaa-0000-4000-8000-000000000001"


@pytest.mark.anyio
async def test_get_card_requests_markdown_format(mock_client, ctx):
    from valaris_mcp.tools.cards import get_card

    mock_client.get.return_value = {"id": CARD_UUID, "description": "# Goal"}
    result = json.loads(await get_card("test", "b1", CARD_UUID, ctx=ctx))

    path = mock_client.get.call_args[0][0]
    assert path.startswith(f"/workspaces/test/boards/b1/cards/{CARD_UUID}")
    assert "format=markdown" in path
    assert result["description"] == "# Goal"
