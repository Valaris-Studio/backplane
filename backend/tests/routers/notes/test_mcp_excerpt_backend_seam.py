# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Opt-in MCP implementation → real HTTP → excerpt-save/auth seam.

RUN_MCP_BACKEND_SEAM=1 runs this beside test_mcp_backend_seam.py. Install
the candidate's own mcp-server/.venv first. This is not an MCP wire-handshake
or PostgreSQL concurrency test; those have separate gates.
"""

import asyncio
import json
import os
import socket
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
import uvicorn
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app.database import get_db
from app.main import create_app
from app.models.activity import Activity
from app.models.agents.agent import Agent, AgentType
from app.models.companion import CompanionInstallation
from app.models.notes.note import Note
from tests.conftest import _raw_api_key
from tests.routers.notes.test_excerpt_note_save import (
    add_member,
    captured_items,
    excerpt_save,
    reviewed_document,
)

pytestmark = [
    pytest.mark.skipif(
        os.environ.get("RUN_MCP_BACKEND_SEAM") != "1",
        reason="opt-in seam requires the separately installed candidate MCP environment",
    ),
    pytest.mark.timeout(90),
    pytest.mark.usefixtures("content_storage"),
]

ROOT = Path(__file__).resolve().parents[4]
SELECTED = "selected café <literal>\n```\nkeep this final newline\n"
PRIVATE_ONLY = "PRIVATE_ONLY_UNSELECTED_HTTP_SEAM"
PROBE = r"""
import asyncio, json, os, sys
from pathlib import Path
from types import SimpleNamespace
import valaris_mcp.server
from valaris_mcp.client import ValarisClient
from valaris_mcp.tools import notes

async def main():
    expected = Path(os.environ["SEAM_EXPECTED_MODULE"]).resolve()
    actual = Path(notes.__file__).resolve()
    assert actual == expected, f"MCP source mismatch: {actual} != {expected}"
    data = json.loads(os.environ["SEAM_DATA"])
    client = ValarisClient()
    ctx = SimpleNamespace(request_context=SimpleNamespace(lifespan_context=SimpleNamespace(client=client)))
    try:
        function = {"create_note": notes.create_note, "get_note": notes.get_note}[data["tool"]]
        result = json.loads(await function(ctx=ctx, **data["arguments"]))
        client_module = Path(sys.modules["valaris_mcp.client"].__file__).resolve()
        assert client_module == expected.parent.parent / "client.py", client_module
        print(json.dumps({"module": str(actual), "client_module": str(client_module), "python": sys.executable, "result": result}))
    finally:
        await client.close()

asyncio.run(main())
"""


class RequestStatuses:
    def __init__(self, app):
        self.app = app
        self.requests = []

    async def __call__(self, scope, receive, send):
        async def record(message):
            if scope["type"] == "http" and message["type"] == "http.response.start":
                self.requests.append(
                    {
                        "method": scope["method"],
                        "path": scope["path"],
                        "status": message["status"],
                    }
                )
            await send(message)

        await self.app(scope, receive, record)


@asynccontextmanager
async def serve(app):
    sock = socket.socket()
    task = None
    server = None
    try:
        sock.bind(("127.0.0.1", 0))
        sock.listen()
        port = sock.getsockname()[1]
        server = uvicorn.Server(
            uvicorn.Config(app, log_level="error", access_log=False, lifespan="off")
        )
        task = asyncio.create_task(server.serve(sockets=[sock]))
        async with asyncio.timeout(10):
            while not server.started:
                if task.done():
                    await task
                    raise AssertionError("HTTP server stopped before readiness")
                await asyncio.sleep(0.01)
        yield f"http://127.0.0.1:{port}"
    finally:
        if server is not None:
            server.should_exit = True
        try:
            if task is not None:
                await asyncio.wait_for(task, 10)
        finally:
            sock.close()


async def mcp_call(url, key, arguments, *, tool="create_note"):
    python = ROOT / "mcp-server/.venv/bin/python"
    assert python.exists(), (
        "Install the candidate MCP environment before this opt-in seam"
    )
    process = await asyncio.create_subprocess_exec(
        str(python),
        "-c",
        PROBE,
        cwd=ROOT / "mcp-server",
        env={
            "PATH": os.environ["PATH"],
            "PYTHONDONTWRITEBYTECODE": "1",
            "VALARIS_API_URL": url,
            "VALARIS_API_KEY": key,
            "SEAM_DATA": json.dumps({"tool": tool, "arguments": arguments}),
            "SEAM_EXPECTED_MODULE": str(
                ROOT / "mcp-server/src/valaris_mcp/tools/notes.py"
            ),
        },
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
        assert process.returncode == 0, stderr.decode() + stdout.decode()
        receipt = json.loads(stdout)
        assert receipt["module"] == str(
            ROOT / "mcp-server/src/valaris_mcp/tools/notes.py"
        )
        print(
            json.dumps(
                {
                    "mcp_module": receipt["module"],
                    "client_module": receipt["client_module"],
                    "python": receipt["python"],
                }
            )
        )
        return receipt["result"]
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


@pytest.fixture
async def excerpt_http(
    db_engine,
    db_session,
    client,
    device_client,
    test_user,
    second_user,
    test_workspace,
    test_board,
    test_card,
):
    session_id, items = await captured_items(
        client,
        device_client,
        db_session,
        test_workspace,
        test_board,
        [SELECTED.encode(), PRIVATE_ONLY.encode()],
    )
    await add_member(db_session, test_workspace, second_user)
    installation_id = await db_session.scalar(
        select(CompanionInstallation.id).where(
            CompanionInstallation.owner_id == test_user.id
        )
    )
    keys = {}
    for name, user, installation in [
        ("owner", test_user, None),
        ("reader", second_user, None),
        ("agent", test_user, None),
        ("installation", test_user, installation_id),
    ]:
        key, raw = _raw_api_key(user, "Synthetic " + name, installation)
        db_session.add(key)
        await db_session.flush()
        keys[name] = raw
        if name == "agent":
            db_session.add(
                Agent(
                    name="Synthetic registered agent",
                    agent_type=AgentType.coding,
                    created_by_id=test_user.id,
                    api_key_id=key.id,
                    allowed_workspaces=[test_workspace.slug],
                )
            )
    await db_session.commit()
    factory = async_sessionmaker(db_engine, expire_on_commit=False)
    app = create_app()

    async def request_transaction():
        # Match get_db ownership; real API-key first-use authentication may
        # commit its own stamp before business work begins.
        async with factory() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = request_transaction
    recorder = RequestStatuses(app)
    document = reviewed_document([SELECTED])
    payload = excerpt_save(
        test_workspace,
        session_id,
        items[:1],
        content=document,
        card_id=str(test_card.id),
    )
    arguments = {
        **payload,
        "content": json.dumps(document, ensure_ascii=False),
        "workspace_slug": test_workspace.slug,
        "board_id": str(test_board.id),
        "return_content": True,
    }
    async with serve(recorder) as url:
        yield {
            "url": url,
            "keys": keys,
            "arguments": arguments,
            "document": document,
            "factory": factory,
            "recorder": recorder,
            "publication": f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}/notes/from-excerpt",
            "contents": f"/api/workspaces/{test_workspace.slug}/sessions/{session_id}/contents",
            "session_id": str(session_id),
            "content_id": items[0]["id"],
        }
    print(json.dumps({"http_requests": recorder.requests}))


async def durable_counts(env):
    async with env["factory"]() as observer:
        return {
            "notes": await observer.scalar(select(func.count()).select_from(Note)),
            "receipts": await observer.scalar(
                text("SELECT count(*) FROM note_save_receipts")
            ),
            "activities": await observer.scalar(
                select(func.count())
                .select_from(Activity)
                .where(Activity.entity_type == "note")
            ),
        }


def publications(env):
    return [
        request for request in env["recorder"].requests if request["method"] == "POST"
    ]


async def publish(env, *, principal="owner", **overrides):
    return await mcp_call(
        env["url"], env["keys"][principal], {**env["arguments"], **overrides}
    )


async def test_mcp_excerpt_save_receipts_cross_real_http(excerpt_http):
    env = excerpt_http
    first = await publish(env)
    assert not first.get("error"), first
    assert json.loads(first["content"]) == env["document"]
    assert first["pinned"] is False and first["kind"] == "user_note"
    assert first["card_id"] == env["arguments"]["card_id"]
    replay = await publish(env)
    assert replay["id"] == first["id"]
    assert json.loads(replay["content"]) == env["document"]
    conflict = await publish(
        env, content=json.dumps(reviewed_document(["Changed review"]))
    )
    assert conflict["error"] is True and conflict["status"] == 409
    assert conflict["error_code"] == "client_request_conflict"
    assert publications(env) == [
        {"method": "POST", "path": env["publication"], "status": status}
        for status in (201, 200, 409)
    ]
    assert await durable_counts(env) == {"notes": 1, "receipts": 1, "activities": 1}
    async with env["factory"]() as observer:
        saved = await observer.scalar(select(Note))
        assert json.loads(saved.content) == env["document"]


async def test_mcp_excerpt_real_machine_keys_cannot_publish_or_replay(excerpt_http):
    env = excerpt_http
    for principal in ("agent", "installation"):
        refused = await publish(env, principal=principal)
        assert refused.get("error") and refused.get("status") == 403, refused
    assert await durable_counts(env) == {"notes": 0, "receipts": 0, "activities": 0}
    saved = await publish(env)
    assert not saved.get("error"), saved
    for principal in ("agent", "installation"):
        shared = await mcp_call(
            env["url"],
            env["keys"][principal],
            {
                "workspace_slug": env["arguments"]["workspace_slug"],
                "board_id": env["arguments"]["board_id"],
                "note_id": saved["id"],
            },
            tool="get_note",
        )
        # A successful shared-note read proves each key is valid; an invalid
        # key's generic403 must not satisfy the publication privacy oracle.
        assert json.loads(shared["content"]) == env["document"]
        refused = await publish(env, principal=principal)
        assert refused.get("error") and refused.get("status") == 403, refused
        assert saved["id"] not in json.dumps(refused)
        assert SELECTED.splitlines()[0] not in json.dumps(refused, ensure_ascii=False)
    assert [request["status"] for request in publications(env)] == [
        403,
        403,
        201,
        403,
        403,
    ]
    assert all(request["path"] == env["publication"] for request in publications(env))
    assert await durable_counts(env) == {"notes": 1, "receipts": 1, "activities": 1}


async def test_mcp_shared_note_does_not_grant_private_source_access(excerpt_http):
    env = excerpt_http
    saved = await publish(env)
    assert not saved.get("error"), saved
    shared = await mcp_call(
        env["url"],
        env["keys"]["reader"],
        {
            "workspace_slug": env["arguments"]["workspace_slug"],
            "board_id": env["arguments"]["board_id"],
            "note_id": saved["id"],
        },
        tool="get_note",
    )
    assert json.loads(shared["content"]) == env["document"]
    assert PRIVATE_ONLY not in json.dumps(shared)
    async with httpx.AsyncClient(
        base_url=env["url"],
        headers={"Authorization": "Bearer " + env["keys"]["reader"]},
    ) as reader:
        for suffix in (
            "",
            f"/{env['content_id']}/body",
            f"/{env['content_id']}/download",
        ):
            path = env["contents"] + suffix
            known = await reader.get(path)
            unknown = await reader.get(
                path.replace(env["session_id"], str(uuid.uuid4()))
            )
            assert known.status_code == unknown.status_code == 404
            assert known.json() == unknown.json()
            assert PRIVATE_ONLY not in known.text
            assert SELECTED.splitlines()[0] not in json.dumps(
                known.json(), ensure_ascii=False
            )
    refused = await publish(env, principal="reader")
    assert refused.get("error") and refused.get("status") == 404, refused
    assert saved["id"] not in json.dumps(refused)
    assert publications(env) == [
        {"method": "POST", "path": env["publication"], "status": status}
        for status in (201, 404)
    ]
    assert await durable_counts(env) == {"notes": 1, "receipts": 1, "activities": 1}


@pytest.mark.parametrize("status", [404, 405])
async def test_mcp_excerpt_legacy_http_refusal_never_falls_back(status):
    generic_writes = []

    async def old_backend(request):
        if request.url.path.endswith("/notes/from-excerpt"):
            return JSONResponse({"detail": "Unsupported route"}, status_code=status)
        generic_writes.append(request.url.path)
        return JSONResponse({"id": str(uuid.uuid4())}, status_code=201)

    recorder = RequestStatuses(
        Starlette(routes=[Route("/{path:path}", old_backend, methods=["POST"])])
    )
    board_id = str(uuid.uuid4())
    async with serve(recorder) as url:
        result = await mcp_call(
            url,
            "vlr_synthetic_legacy_control",
            {
                "workspace_slug": "synthetic",
                "board_id": board_id,
                "title": "Reviewed",
                "content": json.dumps(reviewed_document([SELECTED])),
                "client_request_id": str(uuid.uuid4()),
                "excerpt_source": {
                    "workspace_id": str(uuid.uuid4()),
                    "session_id": str(uuid.uuid4()),
                    "items": [{"content_id": str(uuid.uuid4()), "sha256": "a" * 64}],
                },
            },
        )
    assert result.get("error") and result.get("status") == status, result
    assert generic_writes == []
    assert recorder.requests == [
        {
            "method": "POST",
            "path": f"/api/workspaces/synthetic/boards/{board_id}/notes/from-excerpt",
            "status": status,
        }
    ]
    print(
        json.dumps({"legacy_control_requests": recorder.requests, "generic_writes": 0})
    )
