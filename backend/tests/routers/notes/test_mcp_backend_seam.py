# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Opt-in real MCP HTTP seam without mixing the backend/MCP Python environments.

Run from backend with RUN_MCP_BACKEND_SEAM=1 .venv/bin/python -m pytest
 tests/routers/notes/test_mcp_backend_seam.py. Uses the existing MCP venv only.
"""

import asyncio
import json
import os
from pathlib import Path
import socket
from datetime import datetime, timedelta, timezone

import pytest
import uvicorn

from app.models.notes.note import Note
from app.models.workspace import Workspace

pytestmark = pytest.mark.skipif(
    os.environ.get("RUN_MCP_BACKEND_SEAM") != "1",
    reason="opt-in seam requires the separately installed MCP environment",
)

PROBE = r"""
import asyncio, json, os
from types import SimpleNamespace
from valaris_mcp.client import ValarisClient
import valaris_mcp.server
from valaris_mcp.tools.notes import list_notes
from valaris_mcp.tools.bulk import bulk_create_cards
from valaris_mcp.tools.cards import get_card

async def main():
    data=json.loads(os.environ["SEAM_DATA"])
    client=ValarisClient()
    ctx=SimpleNamespace(request_context=SimpleNamespace(lifespan_context=SimpleNamespace(client=client)))
    async def page(**kwargs):
        return json.loads(await list_notes(workspace_slug="default",ctx=ctx,**kwargs))
    try:
        first=await page(board_id=data["board"])
        assert first["total"]==36 and len(first["notes"])==25 and first["next_offset"]==25,first
        assert data["late"] not in [note["id"] for note in first["notes"]]
        ids=[]; current=first
        while True:
            assert current["total"]==36,current
            assert all("content" not in note for note in current["notes"])
            ids.extend(note["id"] for note in current["notes"])
            if not current["has_more"]:
                assert current["next_offset"] is None
                break
            current=await page(board_id=data["board"],offset=current["next_offset"])
        assert len(ids)==len(set(ids))==36
        assert set(ids)==set(data["ids"])
        match=await page(board_id=data["board"],q="São & café")
        assert match["total"]==1 and match["notes"][0]["id"]==data["late"],match
        full=await page(board_id=data["board"],q="São & café",summary_only=False)
        assert "content" in full["notes"][0],full
        filtered=await page(board_id=data["board"],card_id=data["card"],pinned_only=True,kinds=["plan","custom_kind"],limit=1)
        assert filtered["total"]==2 and filtered["next_offset"]==1,filtered
        second=await page(board_id=data["board"],card_id=data["card"],pinned_only=True,kinds=["plan","custom_kind"],limit=1,offset=1)
        assert second["total"]==2 and not second["has_more"] and second["notes"][0]["id"]!=filtered["notes"][0]["id"],second
        workspace=await page()
        assert workspace["total"]==1 and workspace["notes"][0]["id"]==data["workspace_note"],workspace
        denied=json.loads(await list_notes(workspace_slug="foreign-seam",ctx=ctx))
        assert denied.get("error") and denied.get("status") in (403,404),denied
        description="# Seam context\n\nKeep **metadata** and [a link](https://example.test)."
        bulk=json.loads(await bulk_create_cards("default",data["board"],[{"title":"MCP bulk seam","column_id":data["column"],"git_repo_slug":data["repo"],"description":description}],ctx=ctx))
        assert bulk["created"]==1 and bulk["cards"][0]["git_repo_slug"]==data["repo"],bulk
        assert json.loads(bulk["cards"][0]["description"])["type"]=="doc"
        card=json.loads(await get_card("default",data["board"],bulk["cards"][0]["id"],ctx))
        assert card["git_repo_slug"]==data["repo"] and "**metadata**" in card["description"] and "[a link](https://example.test)" in card["description"],card
        print(json.dumps({"notes_traversed":len(ids),"late_unicode_search":True,"combined_filters":True,"scope":True,"bulk_card_readback":True}))
    finally:
        await client.close()
asyncio.run(main())
"""


async def test_mcp_note_pages_and_bulk_card_readback(
    client,
    db_session,
    test_workspace,
    test_board,
    test_column,
    test_card,
    test_git_repo,
    test_user,
):
    root = Path(__file__).resolve().parents[4]
    python = root / "mcp-server/.venv/bin/python"
    if not python.exists():
        pytest.fail("Install the MCP environment before running this opt-in seam")
    created = []
    for index in range(36):
        text = (
            "Late São & café body"
            if index == 0
            else ("São unrelated" if index == 1 else f"Body {index}")
        )
        note = Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            card_id=test_card.id if index in (0, 30, 31) else None,
            title=f"Inventory {index:02}",
            content=json.dumps(
                {
                    "type": "doc",
                    "content": [
                        {
                            "type": "paragraph",
                            "content": [{"type": "text", "text": text}],
                        }
                    ],
                }
            ),
            content_text=text,
            pinned=index in (30, 31),
            kind="plan" if index % 2 else "custom_kind",
            created_by=test_user.id,
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc)
            + timedelta(seconds=index),
        )
        db_session.add(note)
        created.append(note)
    workspace_note = Note(
        workspace_id=test_workspace.id,
        title="Workspace scope",
        content="",
        created_by=test_user.id,
    )
    foreign = Workspace(
        name="Foreign seam", slug="foreign-seam", created_by=test_user.id
    )
    db_session.add_all([workspace_note, foreign])
    await db_session.flush()
    data = {
        "board": str(test_board.id),
        "card": str(test_card.id),
        "column": str(test_column.id),
        "repo": test_git_repo.slug,
        "late": str(created[0].id),
        "ids": [str(note.id) for note in created],
        "workspace_note": str(workspace_note.id),
    }
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(client._transport.app, log_level="error", lifespan="off")
    )
    task = asyncio.create_task(server.serve(sockets=[sock]))
    process = None
    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("VALARIS_", "PYTHONPATH"))
        }
        env.update(
            {
                "VALARIS_API_URL": f"http://127.0.0.1:{port}",
                "PYTHONPATH": str(root / "mcp-server/src"),
                "SEAM_DATA": json.dumps(data),
            }
        )
        process = await asyncio.create_subprocess_exec(
            str(python),
            "-c",
            PROBE,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
        assert process.returncode == 0, stderr.decode() + stdout.decode()
        assert json.loads(stdout)["notes_traversed"] == 36
    finally:
        if process and process.returncode is None:
            process.kill()
            await process.wait()
        server.should_exit = True
        await asyncio.wait_for(task, timeout=10)
        sock.close()
