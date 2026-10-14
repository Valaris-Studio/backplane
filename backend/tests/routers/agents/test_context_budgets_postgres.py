# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B1 database-boundary races over TCP, using a disposable local PostgreSQL.

READ COMMITTED is explicit. A reader may serialize a mutation with a real lock;
otherwise body guards must hold after the separate transaction commits. These
are scoped-note races, not a promise of per-body membership-revocation locking.
"""

import asyncio
import json
import os
import socket
import uuid
from collections import Counter
from contextvars import ContextVar
from dataclasses import replace

import pytest
import pytest_asyncio
import uvicorn
from fastapi import Request
from httpx import AsyncClient
from sqlalchemy import delete, event, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine
from sqlalchemy.util.concurrency import await_only

from app.database import get_db
from app.main import create_app
from app.models.base import Base
from app.models.notes.note import Note
from tests.routers.agents.context_budgets_support import (
    NOTE_SOURCES,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    assert_manifest,
    expected_block,
    note_for_source,
    source,
    utf8,
)
from tests.routers.agents.context_receipts_support import note_revision

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(40)]
_request_token = ContextVar("budget_test_request_token", default=None)


@pytest_asyncio.fixture
async def db_engine():
    url = os.environ.get("CONTEXT_BUDGET_TEST_DATABASE_URL")
    if not url:
        if os.environ.get("CONTEXT_BUDGET_REQUIRE_PG") == "1":
            pytest.fail("Required disposable PostgreSQL URL is missing")
        pytest.skip("Requires an explicit local disposable PostgreSQL URL")
    parsed = make_url(url)
    assert parsed.drivername == "postgresql+asyncpg"
    assert parsed.host in {"127.0.0.1", "localhost", "::1"}
    assert (parsed.database or "").startswith("context_budgets_")
    schema = "context_budget_test_" + uuid.uuid4().hex
    admin = create_async_engine(url, hide_parameters=True)
    async with admin.begin() as db:
        await db.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        url, hide_parameters=True, pool_size=5, max_overflow=0,
        isolation_level="READ COMMITTED",
        connect_args={"server_settings": {"search_path": schema, "statement_timeout": "8000"}},
    )
    try:
        async with engine.begin() as db:
            await db.run_sync(Base.metadata.create_all)
        yield engine
    finally:
        await engine.dispose()
        async with admin.begin() as db:
            await db.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()


class NoteBoundary:
    def __init__(self):
        self.token = uuid.uuid4().hex
        self.note_id = None
        self.pause = False
        self.reached = asyncio.Event()
        self.release = asyncio.Event()
        self.body_values = {}
        self.body_reads = Counter()
        self.orm_loads = []
        self.projection_reads = []
        self.request_pid = None
        self.request_start_pid = None
        self.mutator_pid = None
        self.isolation = None
        self.serialized_by_reader = False
        self.mutation_committed = False
        self.header_only_boundary = False
        self.lock_control = False
        self.boundary_claimed = False

    async def wait_release(self):
        await asyncio.wait_for(self.release.wait(), 10)

    def returned(self, connection, cursor, statement, parameters, context, executemany):
        if _request_token.get() != self.token or cursor.description is None:
            return
        assert hasattr(cursor, "_rows"), "The PostgreSQL observer requires buffered asyncpg results"
        rows = tuple(cursor._rows)
        for record in rows:
            row = tuple(record)
            for value in row:
                if isinstance(value, str):
                    if value in self.body_values:
                        self.body_reads[self.body_values[value]] += 1
                    elif len(value) >= 8:
                        for body, label in self.body_values.items():
                            if body.startswith(value) or value.startswith(body[:8]):
                                self.body_reads["partial:" + label] += 1
                    if "UNFETCHED_PROJECTION_" in value or "UNFETCHED_FINDINGS_" in value:
                        self.projection_reads.append(value[:90])
                elif isinstance(value, (list, dict)) and "UNFETCHED_FINDINGS_" in json.dumps(value):
                    self.projection_reads.append("structured findings")
            if (self.note_id in row or str(self.note_id) in row) and not self.boundary_claimed:
                self.boundary_claimed = True
                # Auth may have committed/reacquired a pool connection. Observe
                # the connection that actually returned this note row.
                self.request_pid = connection.connection.driver_connection.get_server_pid()
                self.header_only_boundary = not any(
                    isinstance(value, str) and value in self.body_values for value in row
                )
                if self.lock_control:
                    connection.execute(text("SELECT id FROM notes WHERE id = :id FOR UPDATE"), {"id": self.note_id})
                self.reached.set()
                if self.pause:
                    await_only(self.wait_release())

    def loaded(self, note, context):
        self.orm_loads.append(str(note.id))

    def assert_scalar_transfer(self, expected):
        assert self.body_reads == Counter(expected)
        assert self.orm_loads == []
        assert self.projection_reads == []


@pytest_asyncio.fixture
async def pg_budget(budget_case):
    case, boundary = budget_case, NoteBoundary()
    app = create_app()

    @app.middleware("http")
    async def mark_request(request, call_next):
        token = _request_token.set(request.headers.get("X-Budget-Test-Race"))
        try:
            return await call_next(request)
        finally:
            _request_token.reset(token)

    async def transaction(request: Request):
        async with case.receipt.factory() as session:
            marked = request.headers.get("X-Budget-Test-Race") == boundary.token
            if marked:
                boundary.request_start_pid = await session.scalar(text("SELECT pg_backend_pid()"))
                boundary.isolation = await session.scalar(text("SHOW transaction_isolation"))
            try:
                yield session
                await session.commit()
            except BaseException:
                await session.rollback()
                raise

    app.dependency_overrides[get_db] = transaction
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=listener.getsockname()[1], lifespan="off",
        access_log=False, log_level="error",
    ))
    server_task = asyncio.create_task(server.serve(sockets=[listener]))
    event.listen(case.engine.sync_engine, "after_cursor_execute", boundary.returned)
    event.listen(Note, "load", boundary.loaded)
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if server_task.done():
                    await server_task
                await asyncio.sleep(0.01)
        async with AsyncClient(base_url=f"http://127.0.0.1:{listener.getsockname()[1]}", timeout=15) as http:
            headers = {**case.receipt.headers, "agent": {
                **case.receipt.headers["agent"], "X-Budget-Test-Race": boundary.token,
            }}
            yield replace(case, receipt=replace(case.receipt, http=http, headers=headers)), boundary
    finally:
        boundary.release.set()
        event.remove(case.engine.sync_engine, "after_cursor_execute", boundary.returned)
        event.remove(Note, "load", boundary.loaded)
        server.should_exit = True
        try:
            await asyncio.wait_for(server_task, 5)
        finally:
            listener.close()


async def mutate_at_boundary(case, boundary, statement):
    request = asyncio.create_task(case.refresh())
    reached = asyncio.create_task(boundary.reached.wait())
    mutation = None
    try:
        done, _ = await asyncio.wait({request, reached}, timeout=5, return_when=asyncio.FIRST_COMPLETED)
        assert reached in done and boundary.reached.is_set(), (
            "Request returned before a note row or failed to reach the DB boundary within 5 seconds"
        )

        async def commit_mutation():
            async with case.receipt.factory() as db:
                boundary.mutator_pid = await db.scalar(text("SELECT pg_backend_pid()"))
                await db.execute(text("SET LOCAL statement_timeout = '6000ms'"))
                await db.execute(statement)
                await db.commit()
                boundary.mutation_committed = True

        mutation = asyncio.create_task(commit_mutation())
        done, _ = await asyncio.wait({mutation}, timeout=0.4)
        if mutation not in done:
            async with case.receipt.factory() as db:
                blockers = await db.scalar(text("SELECT pg_blocking_pids(:pid)"), {"pid": boundary.mutator_pid})
            assert boundary.request_pid in blockers, "Mutation neither committed nor demonstrably waited on this reader"
            boundary.serialized_by_reader = True
        else:
            await mutation
        boundary.release.set()
        response, _ = await asyncio.wait_for(asyncio.gather(request, mutation), 10)
        assert boundary.mutation_committed
        assert boundary.isolation == "read committed"
        assert boundary.request_pid != boundary.mutator_pid
        return response
    finally:
        boundary.release.set()
        for task in (request, reached, mutation):
            if task is not None and not task.done():
                task.cancel()
        await asyncio.wait_for(asyncio.gather(
            *(task for task in (request, reached, mutation) if task is not None), return_exceptions=True,
        ), 3)


def assert_clean_conflict(response, forbidden):
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] in {
        "context_selection_changed", "execution_context_changed", "context_budget_exceeded",
    }
    assert len(response.content) <= 65536
    for value in forbidden:
        assert value not in response.text
    assert "context_manifest" not in response.json()


@pytest.mark.parametrize("kind", NOTE_SOURCES)
async def test_postgres_guards_actual_utf8_body_bytes_for_every_note_source(pg_budget, kind):
    case, boundary = pg_budget
    note, = await case.seed([note_for_source(kind, content="é" * 40 + "🧭")])
    boundary.note_id = uuid.UUID(note["id"])
    boundary.body_values = {note["content"]: "oversized"}
    await case.configure([source(kind)], max_note_body_bytes=64)
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    boundary.assert_scalar_transfer([])
    assert response.json()["context"] == {"Contexté47": ""}
    assert_manifest(response.json(), {"max_note_body_bytes": 64}, fetched=0, rendered=0)


@pytest.mark.parametrize("kind,change", [
    ("card_notes", "grow"), ("card_notes", "move_card"),
    ("card_notes", "move_workspace"), ("card_notes", "change_kind"),
    ("card_notes", "delete"), ("card_notes", "same_size"),
    ("pinned_notes", "unpin"), ("pinned_notes", "move_board"),
    ("board_definition", "unpin"), ("review_history", "change_kind"),
])
async def test_postgres_body_guard_rechecks_committed_selection_drift(pg_budget, kind, change, record_property):
    case, boundary = pg_budget
    specification = note_for_source(kind, content="old-evidence-é🧭")
    if kind == "card_notes":
        specification["kind"] = "boundary_kind"
    note, = await case.seed([specification])
    boundary.note_id = uuid.UUID(note["id"])
    boundary.pause = True
    updated = {**note, "content": "new-evidence-é🧭" if change == "same_size" else "PRIVATE_NEW_BODY_é🧭"}
    values = {"content": updated["content"], "updated_at": note["updated_at"]}
    if change == "grow":
        updated["content"] = values["content"] = "PRIVATE_GROWN_BODY_" + "é" * 80
    elif change == "move_card":
        values["card_id"] = uuid.UUID(case.receipt.other_card_id)
    elif change == "move_workspace":
        values["workspace_id"] = uuid.UUID(case.receipt.foreign_workspace["id"])
    elif change == "change_kind":
        values["kind"] = "outside_kind"
    elif change == "unpin":
        values["pinned"] = False
    elif change == "move_board":
        values["board_id"] = uuid.UUID(case.receipt.board_id)
    boundary.body_values = {note["content"]: "old", updated["content"]: "new"}
    statement = (delete(Note).where(Note.id == boundary.note_id) if change == "delete" else
                 update(Note).where(Note.id == boundary.note_id).values(**values))
    selected = source(kind, **({"filter": {"kind": "boundary_kind"}} if kind == "card_notes" else {}))
    await case.configure([selected], max_note_body_bytes=64)
    response = await mutate_at_boundary(case, boundary, statement)
    record_property("mutation_committed", boundary.mutation_committed)
    record_property("reader_pid", boundary.request_pid)
    record_property("mutator_pid", boundary.mutator_pid)
    record_property("reader_serialized_mutation", boundary.serialized_by_reader)
    record_property("header_only_boundary", boundary.header_only_boundary)
    # On the legacy baseline this proves its full-body load is the causal red;
    # assertions below become active after the guarded projection is implemented.
    assert boundary.orm_loads == []
    assert boundary.projection_reads == []
    assert boundary.header_only_boundary
    if boundary.serialized_by_reader:
        assert response.status_code == 200, response.text[:500]
        expected = note
    elif response.status_code == 409:
        assert_clean_conflict(response, [updated["content"]])
        assert boundary.body_reads.get("new", 0) == 0 or change == "same_size"
        assert boundary.body_reads.get("old", 0) == 0
        return
    elif change == "same_size":
        assert response.status_code == 200, response.text[:500]
        assert utf8(note["content"]) == utf8(updated["content"])
        expected = updated
    else:
        assert_clean_conflict(response, [updated["content"]])
        return
    block = expected_block(expected, kind, kind_filter=kind == "card_notes")
    assert response.json()["context"] == {"Contexté47": block}
    manifest = assert_manifest(response.json(), {"max_note_body_bytes": 64},
                               fetched=utf8(expected["content"]), rendered=utf8(block))
    if kind == "card_notes":
        record, = manifest["sources"][0]["records"]
        assert record["revision_sha256"] == note_revision(expected)
    else:
        assert manifest["sources"][0]["records"] == []
        assert manifest["sources"][0]["coverage"] == "source_only"
    boundary.assert_scalar_transfer(["old" if boundary.serialized_by_reader else "new"])


@pytest.mark.parametrize("reader_lock", [False, True])
async def test_postgres_boundary_control_observes_real_legacy_snapshot_and_distinct_transactions(pg_budget, reader_lock, record_property):
    case, boundary = pg_budget
    note, = await case.seed([{"content": "old-control-é🧭"}])
    boundary.note_id = uuid.UUID(note["id"])
    boundary.pause = True
    boundary.lock_control = reader_lock
    boundary.body_values = {note["content"]: "old", "new-control-é🧭": "new"}
    await case.configure([source()], enforced=False)
    response = await mutate_at_boundary(case, boundary, update(Note).where(
        Note.id == boundary.note_id,
    ).values(content="new-control-é🧭", updated_at=note["updated_at"]))
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": expected_block(note)}
    assert response.json()["context_manifest"]["schema_version"] == 1
    assert boundary.body_reads == {"old": 1}
    assert boundary.orm_loads == [note["id"]]
    assert not boundary.header_only_boundary
    assert boundary.serialized_by_reader is reader_lock
    record_property("reader_serialized_mutation", boundary.serialized_by_reader)
    record_property("reader_pid", boundary.request_pid)
    record_property("mutator_pid", boundary.mutator_pid)
