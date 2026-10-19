# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Real MCP HTTP edits across separate Python environments and request transactions.

RUN_MCP_BACKEND_SEAM=1 enables the seam. MCP_NOTE_HISTORY_PYTHON may name an
already installed MCP interpreter; PYTHONPATH always points to this checkout.
"""

import asyncio
import json
import os
from pathlib import Path
import socket
from types import SimpleNamespace
import uuid

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker
import uvicorn

from app.database import get_db
from app.models.activity import Activity
from app.models.notes.note import Note

pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(
        os.environ.get("RUN_MCP_BACKEND_SEAM") != "1",
        reason="requires the existing separate MCP Python environment",
    ),
]

INITIAL_BODY = "# Existing\n\nKeep café and **formatting**.\n\n# Other\n\nKeep this section."

PROBE = r'''
import asyncio, json, os
from types import SimpleNamespace
from valaris_mcp.client import ValarisClient
import valaris_mcp.server
from valaris_mcp.tools import notes

async def main():
    data = json.loads(os.environ["MCP_NOTE_HISTORY_DATA"])
    client = ValarisClient()
    requests = []
    async def record(response):
        request = response.request
        requests.append({"method": request.method, "path": request.url.path,
                         "status": response.status_code,
                         "body": json.loads(request.content) if request.content else None})
    client._http.event_hooks["response"].append(record)
    ctx = SimpleNamespace(request_context=SimpleNamespace(lifespan_context=SimpleNamespace(client=client)))
    scope = {"workspace_slug": "default", "note_id": data["note_id"], "board_id": data["board_id"]}
    try:
        before = json.loads(await notes.get_note(**scope, ctx=ctx))
        result = json.loads(await getattr(notes, data["tool"])(**scope, **data["args"], ctx=ctx))
        after = json.loads(await notes.get_note(**scope, ctx=ctx))
        print(json.dumps({"before": before, "result": result, "after": after, "requests": requests}))
    finally:
        await client.close()

asyncio.run(main())
'''


@pytest_asyncio.fixture
async def seam(client, db_engine, db_session, test_workspace, test_board, test_card):
    root = Path(__file__).resolve().parents[4]
    python = Path(os.environ.get("MCP_NOTE_HISTORY_PYTHON", root / "mcp-server/.venv/bin/python"))
    assert python.is_file(), "Supply an existing MCP interpreter; do not skip a requested seam"
    assert db_engine.url.get_backend_name() == "sqlite"
    await db_session.commit()
    factory = async_sessionmaker(db_engine, expire_on_commit=False)

    # The global test client normally only flushes. A separate transaction per
    # HTTP request is essential to prove metadata survived a later failed edit.
    async def committed_request():
        async with factory() as db:
            try:
                yield db
                await db.commit()
            except Exception:
                await db.rollback()
                raise

    app = client._transport.app
    app.dependency_overrides[get_db] = committed_request
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    sock.listen()
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="error", lifespan="off"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    base_url = f"http://127.0.0.1:{port}"

    async def probe(note_id, board_id=None, tool="update_note", **args):
        env = {
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONPATH": str(root / "mcp-server/src"),
            "VALARIS_API_URL": base_url,
            "VALARIS_AGENT_EMAIL": "dev@valaris.dev",
            "MCP_NOTE_HISTORY_DATA": json.dumps({"note_id": note_id, "board_id": board_id, "tool": tool, "args": args}),
        }
        process = await asyncio.create_subprocess_exec(
            str(python), "-c", PROBE, cwd=root / "mcp-server", env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
            assert process.returncode == 0, stderr.decode() + stdout.decode()
            result = json.loads(stdout)
            assert result["before"].get("id") == note_id, result
            assert result["after"].get("id") == note_id, result
            return result
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()

    async def persisted(note_id):
        async with factory() as db:
            note = await db.get(Note, uuid.UUID(note_id))
            count = await db.scalar(select(func.count()).select_from(Activity).where(Activity.entity_id == note.id))
            return {"title": note.title, "content": note.content, "pinned": note.pinned, "card_id": str(note.card_id) if note.card_id else None, "activities": count}

    try:
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        async with httpx.AsyncClient(base_url=base_url) as http:
            async def create(linked=False):
                payload = {"title": "Original title", "content": INITIAL_BODY, "pinned": False}
                if linked:
                    payload["card_id"] = str(test_card.id)
                response = await http.post(f"/api/workspaces/default/boards/{test_board.id}/notes", json=payload)
                assert response.status_code == 201, response.text
                return response.json()

            yield SimpleNamespace(create=create, probe=probe, persisted=persisted, http=http, board_id=str(test_board.id), card_id=str(test_card.id))
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, timeout=10)
        sock.close()


def writes(result):
    return [request for request in result["requests"] if request["method"] in {"POST", "PUT", "PATCH", "DELETE"}]


@pytest.mark.parametrize("board_scope", [False, True])
@pytest.mark.parametrize("failure", ["missing_heading", "empty_append_document"])
async def test_failed_combined_mcp_edit_commits_neither_metadata_nor_body(seam, board_scope, failure):
    note = await seam.create(linked=True)
    before = await seam.persisted(note["id"])
    args = {"title": "Must not commit", "pinned": True, "detach_card": True}
    if failure == "missing_heading":
        args.update(mode="section", anchor_heading="Absent heading", content="Rejected body")
        expected_status = 404
    else:
        args.update(mode="append", content='{"type":"doc","content":[]}')
        expected_status = 422
    result = await seam.probe(note["id"], seam.board_id if board_scope else None, **args)
    assert result["result"].get("error") is True, result
    assert result["result"].get("status") == expected_status, result
    after = await seam.persisted(note["id"])
    assert after == before, {"before": before, "after": after, "requests": writes(result)}


@pytest.mark.parametrize("board_scope", [False, True])
@pytest.mark.parametrize("mode", ["append", "section"])
async def test_successful_combined_mcp_edit_is_one_committed_request(seam, board_scope, mode):
    note = await seam.create()
    before = await seam.persisted(note["id"])
    args = {"mode": mode, "content": "Committed new body", "title": "Committed title", "pinned": True, "card_id": seam.card_id}
    if mode == "section":
        args["anchor_heading"] = "Existing"
    result = await seam.probe(note["id"], seam.board_id if board_scope else None, **args)
    assert not result["result"].get("error"), result
    after = await seam.persisted(note["id"])
    assert after["title"] == "Committed title" and after["pinned"] is True
    assert after["card_id"] == seam.card_id
    assert "Committed new body" in after["content"] and "Keep this section" in after["content"]
    assert result["result"]["content_chars"] == len(after["content"])
    assert "content" not in result["result"]
    expected_path = f"/api/workspaces/default{('/boards/' + seam.board_id) if board_scope else ''}/notes/{note['id']}/edit"
    assert writes(result) == [{"method": "POST", "path": expected_path, "status": 200, "body": args}], writes(result)
    assert after["activities"] == before["activities"] + 1
    assert result["result"]["history_revision"] == note["history_revision"] + 1


async def test_invalid_card_link_rejects_edit_without_partial_body_or_metadata(seam):
    note = await seam.create(linked=True)
    before = await seam.persisted(note["id"])
    result = await seam.probe(note["id"], mode="append", content="Must not append", title="Must not rename", card_id=str(uuid.uuid4()))
    assert result["result"].get("error") is True, result
    assert result["result"].get("status") in {404, 422}, result
    assert await seam.persisted(note["id"]) == before


async def test_replace_omits_link_then_explicit_detach_and_clear_preserve_compatibility(seam):
    note = await seam.create(linked=True)
    result = await seam.probe(note["id"], title="Renamed", pinned=False)
    assert not result["result"].get("error"), result
    assert result["after"]["card_id"] == seam.card_id
    assert result["after"]["content"] == note["content"]
    assert "card_id" not in writes(result)[0]["body"]

    cleared = await seam.probe(note["id"], card_id=seam.card_id, detach_card=True, content="", pinned=False)
    assert not cleared["result"].get("error"), cleared
    assert cleared["after"]["card_id"] is None
    assert cleared["after"]["pinned"] is False
    assert cleared["after"]["title"] == "Renamed"
    assert not json.loads(cleared["after"]["content"]).get("content")
    assert writes(cleared)[0]["body"]["card_id"] is None


@pytest.mark.parametrize("tool", ["append_note", "replace_note_section"])
async def test_deprecated_aliases_mutate_real_note_and_keep_bounded_receipts(seam, tool):
    note = await seam.create(linked=True)
    args = {"content": "Alias change"}
    if tool == "replace_note_section":
        args["anchor_heading"] = "Existing"
    result = await seam.probe(note["id"], seam.board_id, tool=tool, **args)
    assert not result["result"].get("error"), result
    assert "update_note" in result["result"]["_deprecated"]
    assert "content" not in result["result"]
    assert result["result"]["content_chars"] == len(result["after"]["content"])
    assert "Alias change" in result["after"]["content"]
    assert "Keep this section" in result["after"]["content"]
    assert result["after"]["title"] == note["title"] and result["after"]["card_id"] == seam.card_id
    assert len(writes(result)) == 1


async def test_new_edit_route_is_capability_boundary_and_old_routes_remain_usable(seam):
    note = await seam.create()
    before = await seam.persisted(note["id"])
    response = await seam.http.post(f"/api/workspaces/default/notes/{note['id']}/edit", json={"mode": "append", "content": "Atomic entry", "title": "Atomic title"})
    assert response.status_code == 200, response.text
    after = await seam.persisted(note["id"])
    assert after["title"] == "Atomic title" and "Atomic entry" in after["content"]
    assert after["activities"] == before["activities"] + 1

    legacy = await seam.http.post(f"/api/workspaces/default/notes/{note['id']}/append", json={"content": "Legacy entry"})
    assert legacy.status_code == 200, legacy.text
    assert "Atomic entry" in legacy.json()["content"] and "Legacy entry" in legacy.json()["content"]
