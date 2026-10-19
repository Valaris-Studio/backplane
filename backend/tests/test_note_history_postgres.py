# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
import os
import uuid
from dataclasses import dataclass
from contextvars import ContextVar

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.activity import Activity, ActivityAction
from app.models.base import Base
from app.models.kanban.board import Board
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.notes.note import NoteAppend, NoteCreate
from app.services.notes.note import NoteService

pytestmark = pytest.mark.slow


@dataclass
class HistoryPostgres:
    engine: object
    factory: object
    client: AsyncClient
    workspace_id: uuid.UUID
    board_id: uuid.UUID
    owner_id: uuid.UUID
    reader_id: uuid.UUID
    notes_url: str
    principal: dict

    async def create(self):
        response = await self.client.post(self.notes_url, json={"title": "PG history", "content": "Initial"})
        assert response.status_code == 201, response.text
        return response.json()


@pytest.fixture
async def history_pg():
    raw_url = os.environ.get("DATABASE_URL")
    if not raw_url:
        pytest.skip("Explicit root-owned disposable B03 PostgreSQL is required")
    url = make_url(raw_url)
    assert (url.host, url.port, url.database, url.username) == (
        "127.0.0.1", 55446, "note_history_b03_20261018", "b03_test",
    ), "Refusing any database except the dedicated B03 fixture"
    assert url.drivername == "postgresql+asyncpg"
    engine = create_async_engine(raw_url, hide_parameters=True,
        connect_args={"server_settings": {"statement_timeout": "5000", "lock_timeout": "4000"}})
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with engine.connect() as connection:
            identity = (await connection.execute(text(
                "SELECT current_database(), current_user, inet_server_port()"
            ))).one()
            assert tuple(identity) == ("note_history_b03_20261018", "b03_test", 55446)
            assert connection.dialect.name == "postgresql"
    except (OSError, ConnectionError) as exc:
        await engine.dispose()
        pytest.skip(f"Root disposable PostgreSQL unavailable: {type(exc).__name__}")
    owner_id, reader_id, workspace_id, board_id = (uuid.uuid4() for _ in range(4))
    slug = "b03-history-" + workspace_id.hex
    async with factory.begin() as db:
        owner = User(id=owner_id, email=f"{slug}@example.test", name="Owner")
        reader = User(id=reader_id, email=f"{slug}-reader@example.test", name="Reader")
        db.add_all([owner, reader])
        await db.flush()
        db.add(Workspace(id=workspace_id, name="B03 history", slug=slug, created_by=owner_id))
        await db.flush()
        db.add_all([
            WorkspaceMember(workspace_id=workspace_id, user_id=owner_id, role=WorkspaceRole.owner),
            WorkspaceMember(workspace_id=workspace_id, user_id=reader_id, role=WorkspaceRole.member),
            Board(id=board_id, workspace_id=workspace_id, created_by=owner_id, name="History", slug="history"),
        ])
    app = create_app()
    principal = {"user": owner}

    async def transaction():
        async with factory.begin() as db:
            yield db

    async def authenticated_user():
        return principal["user"]

    app.dependency_overrides[get_db] = transaction
    app.dependency_overrides[get_current_user] = authenticated_user
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test") as client:
        fixture = HistoryPostgres(engine, factory, client, workspace_id, board_id,
            owner_id, reader_id, f"/api/workspaces/{slug}/boards/{board_id}/notes", principal)
        try:
            yield fixture
        finally:
            async with factory.begin() as db:
                await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
                await db.execute(delete(User).where(User.id.in_([owner_id, reader_id])))
            await engine.dispose()


async def _wait_for_lock(factory, pid):
    async with asyncio.timeout(3):
        while True:
            async with factory() as observer:
                waiting = await observer.scalar(text(
                    "SELECT wait_event_type = 'Lock' FROM pg_stat_activity WHERE pid = :pid"
                ), {"pid": pid})
            if waiting:
                return
            await asyncio.sleep(0.01)


async def test_concurrent_existing_appends_preserve_both_inputs_after_real_row_wait(history_pg):
    env = history_pg
    created = await env.create()
    note_id = uuid.UUID(created["id"])
    async with env.factory() as first, env.factory() as second:
        first_pid = await first.scalar(text("SELECT pg_backend_pid()"))
        second_pid = await second.scalar(text("SELECT pg_backend_pid()"))
        assert first_pid != second_pid
        await first.scalar(select(Note).where(Note.id == note_id).with_for_update())

        async def second_append():
            await NoteService(second).append_note(note_id, env.workspace_id,
                NoteAppend(content="Second writer"), env.owner_id)
            await second.commit()

        task = asyncio.create_task(second_append())
        try:
            await _wait_for_lock(env.factory, second_pid)
            await NoteService(first).append_note(note_id, env.workspace_id,
                NoteAppend(content="First writer"), env.owner_id)
            await first.commit()
            await asyncio.wait_for(task, 5)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    response = await env.client.get(f"{env.notes_url}/{note_id}")
    assert response.status_code == 200
    assert "First writer" in response.json()["content"], "The waiting append overwrote the first committed append"
    assert "Second writer" in response.json()["content"]
    assert response.json()["history_revision"] == 3


async def test_legacy_service_rechecks_membership_after_a_real_lock_wait(history_pg):
    env = history_pg
    created = await env.create()
    note_id = uuid.UUID(created["id"])
    async with env.factory() as blocker, env.factory() as writer:
        await blocker.scalar(select(Note).where(Note.id == note_id).with_for_update())
        pid = await writer.scalar(text("SELECT pg_backend_pid()"))

        async def append_after_authorization():
            try:
                await NoteService(writer).append_note(note_id, env.workspace_id,
                    NoteAppend(content="Revoked private edit"), env.reader_id)
                await writer.commit()
                return 200
            except Exception as exc:
                await writer.rollback()
                if getattr(exc, "status_code", None) == 403:
                    return 403
                raise

        task = asyncio.create_task(append_after_authorization())
        try:
            await _wait_for_lock(env.factory, pid)
            async with env.factory.begin() as revoker:
                await revoker.execute(delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == env.workspace_id,
                    WorkspaceMember.user_id == env.reader_id,
                ))
            await blocker.rollback()
            assert await asyncio.wait_for(task, 5) == 403
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
    current = await env.client.get(f"{env.notes_url}/{note_id}")
    assert "Revoked private edit" not in current.json()["content"]


async def test_explicit_concurrent_append_retry_creates_only_one_edit(history_pg):
    env = history_pg
    created = await env.create()
    url = f"{env.notes_url}/{created['id']}"
    intent = {"mode": "append", "content": "Retry exactly once", "client_request_id": str(uuid.uuid4())}
    responses = await asyncio.gather(*(env.client.post(url + "/edit", json=intent) for _ in range(2)))
    assert [response.status_code for response in responses] == [200, 200], [r.text for r in responses]
    result = (await env.client.get(url)).json()
    assert result["content"].count("Retry exactly once") == 1
    assert result["history_revision"] == 2
    async with env.factory() as db:
        assert await db.scalar(select(func.count()).select_from(Activity).where(
            Activity.entity_id == uuid.UUID(created["id"]), Activity.action == ActivityAction.updated,
        )) == 1


async def test_note_create_service_does_not_commit_and_rollback_control(history_pg):
    env = history_pg
    async with env.factory() as writer:
        note = await NoteService(writer).create_note(env.workspace_id,
            NoteCreate(title="Outer rollback", content="Never durable"), env.owner_id, env.board_id)
        note_id = note.id
        async with env.factory() as observer:
            assert await observer.get(Note, note_id) is None
            assert await observer.scalar(select(func.count()).select_from(Activity).where(Activity.entity_id == note_id)) == 0
        await writer.rollback()
    async with env.factory() as observer:
        assert await observer.get(Note, note_id) is None
        assert await observer.scalar(select(func.count()).select_from(Activity).where(Activity.entity_id == note_id)) == 0


async def test_history_and_chunks_share_the_caller_transaction_and_rollback(history_pg):
    env = history_pg
    async with env.factory() as writer:
        note = await NoteService(writer).create_note(env.workspace_id,
            NoteCreate(title="Atomic history", content="Private bytes"), env.owner_id, env.board_id)
        note_id = note.id
        assert getattr(note, "history_revision", None) == 1
        tables = [Base.metadata.tables.get(name) for name in (
            "note_revisions", "note_revision_chunks", "note_revision_manifest",
        )]
        assert all(table is not None for table in tables)
        for table in tables:
            assert await writer.scalar(select(func.count()).select_from(table).where(table.c.note_id == note_id)) > 0
        async with env.factory() as observer:
            for table in tables:
                assert await observer.scalar(select(func.count()).select_from(table).where(table.c.note_id == note_id)) == 0
        await writer.rollback()
    async with env.factory() as observer:
        for table in tables:
            assert await observer.scalar(select(func.count()).select_from(table).where(table.c.note_id == note_id)) == 0


async def test_failure_after_history_insert_rolls_back_every_copy_and_retry_receipt(history_pg):
    env = history_pg
    created = await env.create()
    note_id = uuid.UUID(created["id"])
    url = f"{env.notes_url}/{note_id}"
    fired = []

    def fail_after_revision(_conn, _cursor, statement, _params, _ctx, _many):
        if not fired and statement.lstrip().lower().startswith("insert into note_revisions"):
            fired.append(True)
            raise RuntimeError("synthetic failure after history insert")

    event.listen(env.engine.sync_engine, "after_cursor_execute", fail_after_revision)
    intent = {"mode": "append", "content": "Committed on retry", "client_request_id": str(uuid.uuid4())}
    try:
        with pytest.raises(RuntimeError, match="synthetic failure after history insert"):
            await env.client.post(url + "/edit", json=intent)
    finally:
        event.remove(env.engine.sync_engine, "after_cursor_execute", fail_after_revision)
    assert fired
    current = (await env.client.get(url)).json()
    assert current["content"] == created["content"] and current["history_revision"] == 1
    retried = await env.client.post(url + "/edit", json=intent)
    assert retried.status_code == 200, retried.text
    assert retried.json()["history_revision"] == 2
    assert retried.json()["content"].count("Committed on retry") == 1


@pytest.mark.parametrize("loss,expected", [("membership", 403), ("note", 404)])
async def test_revision_read_rechecks_current_access_after_payload_read(
    loss, expected, history_pg, monkeypatch,
):
    env = history_pg
    created = await env.create()
    note_id = uuid.UUID(created["id"])
    url = f"{env.notes_url}/{note_id}"
    control = await env.client.get(url + "/revisions/1")
    assert control.status_code == 200, control.text
    async with env.factory() as db:
        env.principal["user"] = await db.get(User, env.reader_id)
    held, release = asyncio.Event(), asyncio.Event()
    reading_history = ContextVar("b03_reading_history", default=False)
    execute = AsyncSession.execute

    async def hold_loaded_payload(session, statement, *args, **kwargs):
        result = await execute(session, statement, *args, **kwargs)
        if reading_history.get() and "note_revision_chunks" in str(statement).lower() and not held.is_set():
            held.set()
            await release.wait()
        return result

    monkeypatch.setattr(AsyncSession, "execute", hold_loaded_payload)

    async def read_with_hold():
        token = reading_history.set(True)
        try:
            return await env.client.get(url + "/revisions/1")
        finally:
            reading_history.reset(token)

    task = asyncio.create_task(read_with_hold())
    try:
        await asyncio.wait_for(held.wait(), 3)
        async with env.factory.begin() as revoker:
            if loss == "membership":
                await revoker.execute(delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == env.workspace_id,
                    WorkspaceMember.user_id == env.reader_id,
                ))
            else:
                await revoker.execute(delete(Note).where(Note.id == note_id))
        release.set()
        denied = await asyncio.wait_for(task, 5)
        assert denied.status_code == expected, denied.text
        assert "Initial" not in denied.text
        assert "no-store" in denied.headers.get("cache-control", "")
    finally:
        release.set()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)
