# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
from contextlib import asynccontextmanager
from datetime import timedelta
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

VALUES = {
    "due_date": "2026-09-10",
    "status": "paused",
    "labels": ["deferred"],
    "pr_url": "https://example.test/pr/1",
    "branch_name": "work",
    "git_repo_slug": "backend",
}


@pytest.mark.anyio
async def test_nullable_card_patch_preserves_omission_and_clears_idempotently(
    client, test_card, test_board
):
    path = f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}"
    assert (await client.patch(path, json=VALUES)).status_code == 200
    edited = await client.patch(path, json={"title": "Keep metadata"})
    assert edited.status_code == 200
    assert all(edited.json()[field] == value for field, value in VALUES.items())
    for _ in range(2):
        cleared = await client.patch(path, json=dict.fromkeys(VALUES))
        assert cleared.status_code == 200
        assert all(cleared.json()[field] is None for field in VALUES)
        assert cleared.json()["title"] == "Keep metadata"


@pytest.mark.anyio
async def test_nullable_card_clear_rejects_viewer(
    client, db_session, test_card, test_board, test_workspace
):
    membership = await db_session.scalar(
        select(WorkspaceMember).where(WorkspaceMember.workspace_id == test_workspace.id)
    )
    membership.role = WorkspaceRole.viewer
    await db_session.flush()
    path = f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}"
    assert (await client.patch(path, json={"due_date": None})).status_code == 403


@pytest.mark.anyio
async def test_mcp_memory_transport_clears_real_backend_and_preserves_tenant_boundary(
    client,
    db_session,
    test_card,
    test_board,
    second_user,
    monkeypatch,
):
    # Optional cross-component seam: run with the MCP dev environment's site-packages
    # and this checkout's mcp-server/src on PYTHONPATH. Backend-only installs keep
    # their dependency set; the two REST tests above always run.
    pytest.importorskip("mcp")
    monkeypatch.syspath_prepend(
        str(Path(__file__).resolve().parents[2] / "mcp-server" / "src")
    )
    from mcp.server.fastmcp import FastMCP
    from mcp.shared.memory import create_connected_server_and_client_session
    from valaris_mcp.client import ValarisClient
    from valaris_mcp.server import AppContext
    from valaris_mcp.tools.cards import update_card

    api_client = ValarisClient.__new__(ValarisClient)
    api_client._http = client

    @asynccontextmanager
    async def lifespan(_server):
        yield AppContext(client=api_client, tracker=AsyncMock())

    server = FastMCP("clear-fields-backend", lifespan=lifespan)
    server.add_tool(update_card)
    args = {
        "workspace_slug": "default",
        "board_id": str(test_board.id),
        "card_id": str(test_card.id),
    }
    path = f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}"
    assert (await client.patch(path, json=VALUES)).status_code == 200
    foreign = Workspace(name="Other", slug="other-private", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()

    async with create_connected_server_and_client_session(
        server,
        read_timeout_seconds=timedelta(seconds=5),
    ) as session:
        denied = await session.call_tool(
            "update_card",
            {**args, "workspace_slug": foreign.slug, "clear_fields": ["due_date"]},
        )
        assert not denied.isError
        assert json.loads(denied.content[0].text)["status"] in (403, 404)
        assert (await client.get(path)).json()["due_date"] == VALUES["due_date"]
        preserved = await session.call_tool(
            "update_card", {**args, "title": "Keep metadata", "due_date": None}
        )
        assert not preserved.isError
        assert json.loads(preserved.content[0].text)["due_date"] == VALUES["due_date"]
        for _ in range(2):
            cleared = await session.call_tool(
                "update_card", {**args, "clear_fields": list(VALUES)}
            )
            assert not cleared.isError
            payload = json.loads(cleared.content[0].text)
            assert all(payload[field] is None for field in VALUES)
            assert payload["title"] == "Keep metadata"
