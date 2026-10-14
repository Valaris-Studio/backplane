# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Real socket fixtures; only the sessionmaker is routed to the owned test DB."""

import asyncio
import json
import socket
import uuid
from dataclasses import dataclass, field, replace

import pytest_asyncio
import uvicorn
import websockets
from fastapi import Request
from httpx import AsyncClient

from app import database
from app.config import settings
from app.core.event_bus import Event, event_bus
from app.core.session_cookie import SESSION_COOKIE_NAME, write_session
from app.main import create_app
from app.services.events.connection_manager import connection_manager
from tests.routers.agents.context_receipts_support import _receipt_case_fixture  # noqa: F401
from tests.routers.agents.test_context_receipts_postgres import db_engine as _db_engine_fixture

db_engine = _db_engine_fixture

RECEIPT = "execution.context_receipt_created"
OBSERVER = ("execution.completed", "agent.status_changed", "approval.created")


@dataclass
class WireSocket:
    ws: object
    frames: list = field(default_factory=list)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    closed: tuple | None = None
    reader: object = None

    async def read(self):
        try:
            async for raw in self.ws:
                self.frames.append(json.loads(raw))
                self.changed.set()
        except websockets.ConnectionClosed:
            pass
        finally:
            self.closed = (self.ws.close_code, self.ws.close_reason)
            self.changed.set()

    async def until(self, predicate, *, timeout=3, allow_closed=False):
        async with asyncio.timeout(timeout):
            while True:
                for frame in self.frames:
                    if predicate(frame):
                        return frame
                if allow_closed and self.closed is not None:
                    return None
                self.changed.clear()
                await self.changed.wait()

    def events(self, name):
        return [f for f in self.frames if f.get("event") == name]


@dataclass
class WireCase:
    case: object
    ws_base: str
    hold_token: str = field(default_factory=lambda: uuid.uuid4().hex)
    held: asyncio.Event = field(default_factory=asyncio.Event)
    release: asyncio.Event = field(default_factory=asyncio.Event)
    rollback: bool = False
    sockets: list = field(default_factory=list)

    async def connect(self, actor, patterns, *, foreign=False):
        workspace = self.case.foreign_workspace if foreign else self.case.workspace
        ws = await websockets.connect(self.ws_base + f"/ws/workspaces/{workspace['slug']}/events",
                                      additional_headers=self.case.headers[actor], open_timeout=3)
        client = WireSocket(ws)
        client.reader = asyncio.create_task(client.read())
        self.sockets.append(client)
        await ws.send(json.dumps({"subscribe": ["card.*", *patterns]}))
        # There is no subscribe acknowledgement. Actual delivery of a repeated
        # public marker proves registration; a delay alone would not.
        for attempt in range(20):
            marker = "ready-" + uuid.uuid4().hex
            await self.publish("card.updated", {"marker": marker}, foreign=foreign)
            try:
                await client.until(lambda f: f.get("payload", {}).get("marker") == marker, timeout=0.1)
                break
            except TimeoutError:
                if attempt == 19:
                    raise
        return client

    async def publish(self, name, payload, *, foreign=False, remote=False):
        workspace = self.case.foreign_workspace if foreign else self.case.workspace
        wid = uuid.UUID(workspace["id"])
        if remote:
            await event_bus._dispatch_local(Event(event_type=name, payload=payload, workspace_id=wid, remote=True))
        else:
            await event_bus.publish(name, payload, wid)

    async def barrier(self, clients, *, foreign=False):
        marker = "barrier-" + uuid.uuid4().hex
        await self.publish("card.updated", {"marker": marker}, foreign=foreign)
        for client in clients:
            await client.until(lambda f: f.get("payload", {}).get("marker") == marker)

    async def member_role(self, role):
        response = await self.case.http.patch(
            f"/api/workspaces/{self.case.workspace['slug']}/members/{self.case.recipient_id}",
            json={"role": role}, headers=self.case.headers["curator"],
        )
        assert response.status_code == 200, response.text

    async def begin_receipt(self):
        assignment = await self.case.assignment()
        execution = await self.case.start(assignment)
        return execution, self.case.receipt_payload(assignment, prompt="PRIVATE_WIRE_PROMPT é🧭\r\n")


@pytest_asyncio.fixture(name="wire_case")
async def _wire_case_fixture(receipt_case, db_engine, monkeypatch):
    original_bind = database.async_session.kw["bind"]
    database.async_session.configure(bind=db_engine)
    monkeypatch.setattr(settings, "ENV", "production")
    monkeypatch.setattr(settings, "OAUTH_STATE_SIGNING_KEY", uuid.uuid4().hex)
    case, app = receipt_case, create_app()
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    fixture = WireCase(case, f"ws://127.0.0.1:{port}")

    async def transaction(request: Request):
        async with case.factory() as session:
            try:
                yield session
                if request.headers.get("X-Event-Test-Hold") == fixture.hold_token:
                    assert session.in_transaction(), "Service stole the caller-owned outer transaction"
                    fixture.held.set()
                    await asyncio.wait_for(fixture.release.wait(), 10)
                    if fixture.rollback:
                        await session.rollback()
                        raise RuntimeError("Synthetic caller-owned rollback")
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    app.dependency_overrides[database.get_db] = transaction
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, lifespan="off",
                                         access_log=False, log_level="critical"))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        async with AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=15) as http:
            signed = write_session(uuid.UUID(case.recipient_id), signing_key=settings.OAUTH_STATE_SIGNING_KEY)
            fixture.case = replace(case, http=http, headers={**case.headers,
                "session": {"Cookie": SESSION_COOKIE_NAME + "=" + signed}})
            yield fixture
    finally:
        fixture.release.set()
        for client in fixture.sockets:
            await client.ws.close()
            await asyncio.wait_for(client.reader, 3)
        await connection_manager.shutdown()
        server.should_exit = True
        await asyncio.wait_for(task, 5)
        listener.close()
        database.async_session.configure(bind=original_bind)
