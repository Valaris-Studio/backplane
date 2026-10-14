# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Real HTTP races against an explicitly supplied disposable PostgreSQL.

CONTEXT_RECEIPT_TEST_DATABASE_URL must name a local context_receipts_* DB.
Each test owns one schema; this qualifies transaction behavior, not migrations.
"""

import asyncio
import os
import socket
import uuid
from dataclasses import dataclass, replace

import pytest
import pytest_asyncio
import uvicorn
from fastapi import Request
from httpx import AsyncClient
from sqlalchemy import delete, event, func, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import create_async_engine

from app.database import get_db
from app.main import create_app
from app.models.agents.execution import AgentExecution
from app.models.base import Base
from app.models.workspace import WorkspaceMember
from tests.routers.agents.context_receipts_support import (
    ALIAS,
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_receipts import mutate_note, mutate_source_config

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]


@pytest_asyncio.fixture
async def db_engine():
    url = os.environ.get("CONTEXT_RECEIPT_TEST_DATABASE_URL")
    if not url:
        if os.environ.get("CONTEXT_RECEIPT_REQUIRE_PG") == "1":
            pytest.fail("The required disposable PostgreSQL URL is missing")
        pytest.skip("Requires an explicit disposable PostgreSQL URL")
    parsed = make_url(url)
    assert parsed.drivername == "postgresql+asyncpg"
    assert parsed.host in {"127.0.0.1", "localhost", "::1"}
    assert (parsed.database or "").startswith("context_receipts_")
    schema = "context_receipt_test_" + uuid.uuid4().hex
    admin = create_async_engine(url, hide_parameters=True)
    async with admin.begin() as db:
        await db.execute(text(f'CREATE SCHEMA "{schema}"'))
    engine = create_async_engine(
        url, hide_parameters=True, pool_size=5, max_overflow=0,
        connect_args={"server_settings": {"search_path": schema}},
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


class RequestGate:
    """Synchronize actual request transactions before auth/service code.

    The optional held mode admits all requests, then lets the test commit a
    separate mutation before those requests query authorization or context.
    """

    def arm(self, count, *, held=False):
        self.token = uuid.uuid4().hex
        self.count = count
        self.pids = set()
        self.application_name = "receipt-test-" + self.token
        self.transaction_pids = []
        self.arrived = asyncio.Event()
        self.release = asyncio.Event()
        if not held:
            self.release.set()
        return {"X-Context-Receipt-Test-Race": self.token}

    async def enter(self, request, session):
        if not getattr(self, "token", None) or request.headers.get("X-Context-Receipt-Test-Race") != self.token:
            return
        application_name = self.application_name

        def observe_transaction(_session, _transaction, connection):
            # Auth may commit before route work and release its connection.
            # Tag every real transaction, without changing its lifetime; LOCAL
            # restores the pooled connection's name on commit or rollback.
            row = connection.execute(text(
                "SELECT set_config('application_name', :name, true), pg_backend_pid() AS pid"
            ), {"name": application_name}).one()
            self.transaction_pids.append(row.pid)

        event.listen(session.sync_session, "after_begin", observe_transaction)
        session.info["context_receipt_test_observer"] = observe_transaction
        self.pids.add(await session.scalar(text("SELECT pg_backend_pid()")))
        if len(self.pids) == self.count:
            self.arrived.set()
        await asyncio.wait_for(self.arrived.wait(), 10)
        await asyncio.wait_for(self.release.wait(), 10)

    def leave(self, session):
        observer = session.info.pop("context_receipt_test_observer", None)
        if observer is not None:
            event.remove(session.sync_session, "after_begin", observer)


@dataclass
class HTTPCase:
    case: object
    gate: RequestGate

    async def race(self, method, path, payloads, *, actor="agent", after_arrival=None):
        case, gate = self.case, self.gate
        headers = {**case.headers[actor], **gate.arm(len(payloads), held=after_arrival is not None)}
        tasks = [asyncio.create_task(case.http.request(method, path, json=payload, headers=headers))
                 for payload in payloads]
        try:
            if after_arrival is not None:
                await asyncio.wait_for(gate.arrived.wait(), 10)
                await after_arrival()
                gate.release.set()
            responses = await asyncio.wait_for(asyncio.gather(*tasks), 20)
        finally:
            gate.release.set()
            for task in tasks:
                if not task.done():
                    task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
        return responses

    def assert_connections(self, count):
        assert len(self.gate.pids) == count, "Race did not hold distinct PostgreSQL transactions"


@pytest_asyncio.fixture
async def pg_http(receipt_case):
    # Reuse the exact independently frozen synthetic content and real API keys.
    case = receipt_case
    app, gate = create_app(), RequestGate()

    async def transaction(request: Request):
        async with case.factory() as session:
            try:
                await gate.enter(request, session)
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise
            finally:
                gate.leave(session)

    app.dependency_overrides[get_db] = transaction
    listener = socket.socket()
    listener.bind(("127.0.0.1", 0))
    listener.listen()
    port = listener.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(
        app, host="127.0.0.1", port=port, lifespan="off", access_log=False, log_level="error",
    ))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        async with AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=25) as http:
            yield HTTPCase(replace(case, http=http), gate)
    finally:
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        finally:
            listener.close()


def statuses(responses):
    return sorted(response.status_code for response in responses)


async def execution_count(case):
    async with case.factory() as db:
        return await db.scalar(select(func.count()).select_from(AgentExecution))


async def history(case, execution, expected):
    response = await case.http.get(
        case.execution_path(execution["id"]) + "/context-receipts",
        headers=case.headers["curator"],
    )
    assert response.status_code == 200, response.text
    assert int(response.headers["X-Total-Count"]) == expected
    assert len(response.json()) == expected
    return response.json()


async def test_postgres_http_gate_uses_distinct_authenticated_request_transactions(pg_http):
    case = pg_http.case
    responses = await pg_http.race("GET", f"/api/agents/{case.agent_id}", [None, None])
    assert statuses(responses) == [200, 200], [r.text for r in responses]
    pg_http.assert_connections(2)
    assert {r.json()["id"] for r in responses} == {case.agent_id}


async def test_postgres_gate_tracks_auth_commit_without_leaking_request_tag(pg_http):
    case, gate = pg_http.case, pg_http.gate
    # This fresh API key's usage stamp commits in actual authentication;
    # authorization and route work then start another real transaction.
    responses = await pg_http.race("GET", f"/api/agents/{case.agent_id}", [None])
    assert statuses(responses) == [200], [r.text for r in responses]
    assert responses[0].json()["id"] == case.agent_id
    pg_http.assert_connections(1)
    assert len(gate.transaction_pids) >= 2, "Auth commit did not open a second observed transaction"
    assert gate.pids.issubset(gate.transaction_pids)
    async with case.factory() as observer:
        retained = await observer.scalar(text(
            "SELECT count(*) FROM pg_stat_activity "
            "WHERE datname = current_database() AND application_name = :name"
        ), {"name": gate.application_name})
    assert retained == 0, "Request tag leaked past commit into the connection pool"


async def test_postgres_identical_hold_promotions_create_one_execution(pg_http):
    case = pg_http.case
    assignment = await case.assignment()
    path, payload = f"/api/agents/{case.agent_id}/executions", case.start_payload(assignment)
    responses = await pg_http.race("POST", path, [payload] * 4)
    assert statuses(responses) == [200, 200, 200, 201], [r.text for r in responses]
    pg_http.assert_connections(4)
    assert len({r.json()["id"] for r in responses}) == 1
    assert await execution_count(case) == 1
    replay = await case.http.post(path, json=payload, headers=case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == responses[0].json()["id"]


@pytest.mark.parametrize("mismatch", ["payload", "tuple"])
async def test_postgres_conflicting_hold_promotions_never_create_two_executions(pg_http, mismatch):
    case = pg_http.case
    assignment = await case.assignment()
    payload = case.start_payload(assignment)
    other = {**payload, **({"input_summary": "Different request"} if mismatch == "payload"
                          else {"role": "different_operator_role"})}
    path = f"/api/agents/{case.agent_id}/executions"
    responses = await pg_http.race("POST", path, [payload, other])
    assert statuses(responses) == [201, 409 if mismatch == "payload" else 404], [r.text for r in responses]
    pg_http.assert_connections(2)
    assert await execution_count(case) == 1
    winner = next(index for index, response in enumerate(responses) if response.status_code == 201)
    replay = await case.http.post(path, json=[payload, other][winner], headers=case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == responses[winner].json()["id"]


@pytest.mark.parametrize("kind", ["identical", "conflicting", "distinct"])
async def test_postgres_receipt_races_preserve_keys_snapshots_and_unique_ordinals(pg_http, kind):
    case = pg_http.case
    context = await case.assignment()
    execution = await case.start(context)
    payload = case.receipt_payload(context)
    if kind == "identical":
        payloads, expected_status, expected_count = [payload] * 4, [200, 200, 200, 201], 1
    elif kind == "conflicting":
        payloads = [payload, {**payload, "input_prompt": "Conflicting retained prompt"}]
        expected_status, expected_count = [201, 409], 1
    else:
        payloads = [case.receipt_payload(context, prompt=f"Invocation {i} 🧪") for i in range(4)]
        expected_status, expected_count = [201] * 4, 4
    path = case.execution_path(execution["id"]) + "/context-receipts"
    responses = await pg_http.race("POST", path, payloads)
    assert statuses(responses) == expected_status, [r.text for r in responses]
    pg_http.assert_connections(len(payloads))
    accepted = [(payload, response.json()) for payload, response in zip(payloads, responses)
                if response.status_code in {200, 201}]
    assert len({receipt["id"] for _, receipt in accepted}) == expected_count
    assert {receipt["ordinal"] for _, receipt in accepted} == set(range(1, expected_count + 1))
    assert {row["id"] for row in await history(case, execution, expected_count)} == {
        receipt["id"] for _, receipt in accepted
    }
    for request, receipt in accepted:
        retained = await case.receipt(execution, receipt["id"])
        assert retained.status_code == 200, retained.text
        for field in ("input_prompt", "system_prompt", "provider", "model", "context_revision"):
            assert retained.json()[field] == request[field]
        retry = await case.http.post(path, json=request, headers=case.headers["agent"])
        assert retry.status_code == 200 and retry.json()["id"] == receipt["id"]
        assert retry.json()["ordinal"] == receipt["ordinal"]
    await history(case, execution, expected_count)


@pytest.mark.parametrize("change", ["note", "config", "authorization"])
async def test_postgres_arrived_retries_recheck_committed_changes_before_replay(pg_http, change):
    case = pg_http.case
    context = await case.assignment()
    execution = await case.start(context)
    payload = case.receipt_payload(context)
    path = case.execution_path(execution["id"]) + "/context-receipts"
    response = await case.http.post(path, json=payload, headers=case.headers["agent"])
    assert response.status_code == 201, response.text
    original = (await case.receipt(execution, response.json()["id"])).json()

    async def commit_change():
        if change == "note":
            await mutate_note(case, "content")
        elif change == "config":
            await mutate_source_config(case, "filter")
        else:
            async with case.factory() as db:
                await db.execute(delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == uuid.UUID(case.workspace["id"]),
                    WorkspaceMember.user_id == uuid.UUID(case.recipient_id),
                ))
                await db.commit()

    responses = await pg_http.race("POST", path, [payload, payload], after_arrival=commit_change)
    expected = 403 if change == "authorization" else 409
    assert statuses(responses) == [expected, expected], [r.text for r in responses]
    pg_http.assert_connections(2)
    if change != "authorization":
        assert all(r.json()["error_code"] == "execution_context_changed" for r in responses)
    else:
        assert all(ALIAS not in r.text for r in responses)
    retained = await case.receipt(execution, original["id"], actor="curator")
    assert retained.status_code == 200 and retained.json() == original
    await history(case, execution, 1)
    if change != "authorization":
        fresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                    headers=case.headers["agent"])
        assert fresh.status_code == 200 and fresh.json()["context_revision"] != payload["context_revision"]
        prepared = await case.prepare(execution, fresh.json())
        assert prepared.status_code == 201 and prepared.json()["ordinal"] == 2, prepared.text
        await history(case, execution, 2)
