# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""create_note forwards the optional excerpt save fields to the dedicated
publication route, which an older backend lacks, so a save there can never
degrade into an ordinary note; who may publish is decided by the backend."""

from __future__ import annotations

import json

import httpx
import pytest

from valaris_mcp.server import mcp

pytestmark = pytest.mark.anyio

SOURCE = {
    "workspace_id": "11111111-1111-1111-1111-111111111111",
    "session_id": "22222222-2222-2222-2222-222222222222",
    "items": [{"content_id": "33333333-3333-3333-3333-333333333333", "sha256": "a" * 64}],
}
REVIEWED = json.dumps(
    {"type": "doc", "content": [{"type": "codeBlock", "content": [{"type": "text", "text": "x"}]}]}
)


def test_create_note_schema_offers_both_excerpt_fields_as_optional():
    tool = mcp._tool_manager._tools["create_note"].parameters
    assert {"client_request_id", "excerpt_source"} <= set(tool["properties"])
    assert not {"client_request_id", "excerpt_source"} & set(tool.get("required", []))


async def test_create_note_forwards_an_excerpt_save(mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1", "content": REVIEWED}
    await create_note(
        "test",
        "Reviewed handoff",
        content=REVIEWED,
        board_id="b1",
        client_request_id="44444444-4444-4444-4444-444444444444",
        excerpt_source=SOURCE,
        ctx=ctx,
    )
    mock_client.post.assert_called_once_with(
        "/workspaces/test/boards/b1/notes/from-excerpt",
        {
            "title": "Reviewed handoff",
            "content": REVIEWED,
            "pinned": False,
            "kind": "user_note",
            "client_request_id": "44444444-4444-4444-4444-444444444444",
            "excerpt_source": SOURCE,
        },
    )


async def test_create_note_without_excerpt_fields_sends_the_generic_body(mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    await create_note("test", "Plain", content="# Heading", ctx=ctx)
    body = mock_client.post.call_args[0][1]
    assert "client_request_id" not in body and "excerpt_source" not in body


@pytest.mark.parametrize(
    "fields",
    [
        {"client_request_id": "44444444-4444-4444-4444-444444444444", "excerpt_source": SOURCE},
        {"excerpt_source": SOURCE},
        {"client_request_id": "44444444-4444-4444-4444-444444444444"},
    ],
    ids=["both", "source-only", "request-id-only"],
)
async def test_an_excerpt_save_without_a_board_is_refused_before_any_request(fields, mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    result = json.loads(await create_note("test", "Reviewed", content=REVIEWED, ctx=ctx, **fields))
    assert result["error"] is True and "board_id" in result["message"]
    mock_client.post.assert_not_called()


async def test_one_excerpt_field_alone_still_goes_to_the_publication_route(mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    mock_client.post.return_value = {"id": "n1"}
    await create_note("test", "Reviewed", content=REVIEWED, board_id="b1", excerpt_source=SOURCE, ctx=ctx)
    assert mock_client.post.call_args[0][0] == "/workspaces/test/boards/b1/notes/from-excerpt"


@pytest.mark.parametrize("status", [404, 405])
async def test_an_old_backend_without_the_route_refuses_with_no_generic_fallback(status, mock_client, ctx):
    from valaris_mcp.tools.notes import create_note

    url = "http://backend.test/api/workspaces/test/boards/b1/notes/from-excerpt"
    old_backend = httpx.Response(status, json={"detail": "Not Found"}, request=httpx.Request("POST", url))
    mock_client.post.side_effect = httpx.HTTPStatusError("old backend", request=old_backend.request, response=old_backend)
    result = json.loads(
        await create_note(
            "test",
            "Reviewed",
            content=REVIEWED,
            board_id="b1",
            client_request_id="44444444-4444-4444-4444-444444444444",
            excerpt_source=SOURCE,
            ctx=ctx,
        )
    )
    assert result["error"] is True and result["status"] == status
    mock_client.post.assert_called_once()
    assert mock_client.post.call_args[0][0].endswith("/notes/from-excerpt")
