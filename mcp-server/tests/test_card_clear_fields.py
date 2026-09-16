# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
from contextlib import asynccontextmanager
from datetime import timedelta

import pytest
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session

from valaris_mcp.tools.cards import update_card

CARD_ID = "12345678-1234-1234-1234-123456789012"
FIELDS = ["due_date", "status", "labels", "pr_url", "branch_name", "git_repo_slug"]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def server(ctx):
    @asynccontextmanager
    async def lifespan(_server):
        yield ctx.request_context.lifespan_context

    server = FastMCP("clear-field-test", lifespan=lifespan)
    server.add_tool(update_card)
    return server


def arguments(**values):
    return {"workspace_slug": "test", "board_id": "b1", "card_id": CARD_ID, **values}


@pytest.mark.anyio
async def test_transport_clears_nullable_fields_and_preserves_legacy_null(server, mock_client):
    mock_client.patch.return_value = {"id": CARD_ID}
    async with create_connected_server_and_client_session(
        server,
        read_timeout_seconds=timedelta(seconds=5),
    ) as session:
        result = await session.call_tool("update_card", arguments(clear_fields=FIELDS))
        assert not result.isError
        mock_client.patch.assert_awaited_once_with(
            f"/workspaces/test/boards/b1/cards/{CARD_ID}",
            dict.fromkeys(FIELDS),
        )
        mock_client.patch.reset_mock()
        result = await session.call_tool("update_card", arguments(title="Edited", due_date=None))
        assert not result.isError
        mock_client.patch.assert_awaited_once_with(
            f"/workspaces/test/boards/b1/cards/{CARD_ID}",
            {"title": "Edited"},
        )


@pytest.mark.anyio
@pytest.mark.parametrize(
    "field", ["title", "description", "priority", "card_type", "board_id", "unknown"]
)
async def test_transport_rejects_unknown_and_nonnullable_clear_fields(server, mock_client, field):
    async with create_connected_server_and_client_session(
        server,
        read_timeout_seconds=timedelta(seconds=5),
    ) as session:
        result = await session.call_tool("update_card", arguments(clear_fields=[field]))
        assert result.isError or json.loads(result.content[0].text).get("error") is True
        mock_client.patch.assert_not_awaited()
        mock_client.get.assert_not_awaited()


@pytest.mark.anyio
@pytest.mark.parametrize(
    "field,value", [("due_date", "2026-09-10"), ("status", ""), ("labels", [])]
)
async def test_clear_conflict_is_explicit_and_makes_no_request(ctx, mock_client, field, value):
    result = json.loads(
        await update_card(**arguments(clear_fields=[field], **{field: value}), ctx=ctx)
    )
    assert result["error"] is True
    assert result["status"] == 422
    assert field in result["message"]
    mock_client.patch.assert_not_awaited()
    mock_client.get.assert_not_awaited()


@pytest.mark.anyio
async def test_repeated_clear_is_same_idempotent_patch(ctx, mock_client):
    mock_client.patch.return_value = {"id": CARD_ID, "due_date": None}
    for _ in range(2):
        result = json.loads(
            await update_card(**arguments(clear_fields=["due_date", "due_date"]), ctx=ctx)
        )
        assert result["due_date"] is None
    assert mock_client.patch.await_count == 2
    assert all(call.args[1] == {"due_date": None} for call in mock_client.patch.await_args_list)
