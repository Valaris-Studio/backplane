# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Required-policy activation must serialize with legacy scheduling and starts.

Only the real request's outer commit is held. The second operation may wait on
any database lock held by the first or refuse atomically; no production lock
helper, statement shape, isolation level or policy service is substituted.
"""

import asyncio
import copy
import json
import socket
import uuid
from dataclasses import dataclass, replace

import pytest
import pytest_asyncio
import uvicorn
from fastapi import Request
from httpx import AsyncClient
from sqlalchemy import func, select, text

from app.database import get_db
from app.main import create_app
from app.models.agents.execution import AgentExecution
from app.models.workspace_config import WorkspaceConfig
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)
from tests.routers.agents.test_context_receipts_postgres import (
    RequestGate,
    db_engine,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(45)]


class OuterCommitHold:
    def __init__(self):
        self.token = uuid.uuid4().hex
        self.arrived = asyncio.Event()
        self.release = asyncio.Event()
        self.pid = None

    async def before_commit(self, request, session):
        if request.headers.get("X-A2-Hold-Before-Commit") != self.token:
            return
        assert session.in_transaction(), "Request committed behind its outer transaction owner"
        self.pid = await session.scalar(text("SELECT pg_backend_pid()"))
        self.arrived.set()
        await asyncio.wait_for(self.release.wait(), 15)


@dataclass
class FloorHTTP:
    dispatch: object
    gate: RequestGate
    hold: OuterCommitHold


@pytest_asyncio.fixture
async def floor_http(dispatch_case):
    case = dispatch_case.case
    gate, hold, app = RequestGate(), OuterCommitHold(), create_app()

    async def transaction(request: Request):
        async with case.factory() as session:
            try:
                await gate.enter(request, session)
                yield session
                await hold.before_commit(request, session)
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
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port,
                                         lifespan="off", access_log=False, log_level="error"))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    try:
        async with asyncio.timeout(5):
            while not server.started:
                if task.done():
                    await task
                await asyncio.sleep(0.01)
        async with AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=20) as http:
            yield FloorHTTP(replace(dispatch_case, case=replace(case, http=http)), gate, hold)
    finally:
        hold.release.set()
        server.should_exit = True
        try:
            await asyncio.wait_for(task, 5)
        finally:
            listener.close()


async def observe_second_transaction(f, second, record_property):
    """Observe the live transaction after any authentication commit/rebind."""
    async with asyncio.timeout(8):
        while True:
            if second.done():
                response = await second
                record_property("second_before_first_commit", json.dumps({
                    "status": response.status_code, "error_code": response.json().get("error_code"),
                }))
                return "refused" if response.status_code == 409 else "completed_early"
            async with f.dispatch.case.factory() as db:
                rows = (await db.execute(text(
                    "SELECT pid, state, wait_event_type, wait_event, query, "
                    "pg_blocking_pids(pid) AS blockers FROM pg_stat_activity "
                    "WHERE application_name = :tag AND datname = current_database() AND pid <> :first"
                ), {"tag": f.gate.application_name, "first": f.hold.pid})).mappings().all()
            for row in rows:
                if row["wait_event_type"] == "Lock" and f.hold.pid in row["blockers"]:
                    record_property("shared_serialization_wait", json.dumps({
                        "owned_first_pid": f.hold.pid, **dict(row),
                        "observed_transaction_pids": f.gate.transaction_pids,
                    }))
                    return "waited"
            await asyncio.sleep(0.01)


@pytest.mark.parametrize("legacy_operation", ["assignment", "bound_start", "direct_start"])
@pytest.mark.parametrize("first_operation", ["activation", "legacy"])
async def test_policy_activation_and_legacy_operations_have_no_unversioned_execution_gap(
    floor_http, legacy_operation, first_operation, record_property,
):
    f, d = floor_http, floor_http.dispatch
    config = await d.config()
    pipeline = copy.deepcopy(config["pipeline_config"])
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    activation = {"method": "PATCH", "url": d.config_path,
                  "json": {"pipeline_config": pipeline, "expected_version": config["version"]},
                  "headers": d.headers("recipient", version=None)}
    if legacy_operation == "assignment":
        legacy = {"method": "POST", "url": d.agent_path() + "/next-assignment",
                  "json": {"board_id": d.case.board_id}, "headers": d.headers(version=None)}
    else:
        assignment = await d.case.assignment()
        payload = d.case.start_payload(assignment)
        if legacy_operation == "direct_start":
            payload.pop("reservation_id")
        legacy = {"method": "POST", "url": f"/api/agents/{d.case.agent_id}/executions",
                  "json": payload, "headers": d.headers(version=None)}
    first_args, second_args = (activation, legacy) if first_operation == "activation" else (legacy, activation)
    tag_headers = f.gate.arm(1)
    first_args["headers"] = {**first_args["headers"], **tag_headers, "X-A2-Hold-Before-Commit": f.hold.token}
    second_args["headers"] = {**second_args["headers"], **tag_headers}
    first = asyncio.create_task(d.case.http.request(**first_args))
    arrived = asyncio.create_task(f.hold.arrived.wait())
    second = None
    try:
        done, _ = await asyncio.wait({first, arrived}, timeout=8, return_when=asyncio.FIRST_COMPLETED)
        assert arrived in done, (await first).text if first.done() else "First real request never reached its outer commit"
        second = asyncio.create_task(d.case.http.request(**second_args))
        serialization = await observe_second_transaction(f, second, record_property)
        f.hold.release.set()
        first_response, second_response = await asyncio.wait_for(asyncio.gather(first, second), 10)
    finally:
        f.hold.release.set()
        arrived.cancel()
        for task in [first, second]:
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*[t for t in [arrived, first, second] if t is not None], return_exceptions=True)

    activated, legacy_result = ((first_response, second_response) if first_operation == "activation"
                                 else (second_response, first_response))
    async with d.case.factory() as db:
        saved = await db.scalar(select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == uuid.UUID(d.case.workspace["id"])))
        required = d.case.agent_id in saved.pipeline_config.get("context_dispatch", {}).get("required_agent_ids", [])
        count = await db.scalar(select(func.count()).select_from(AgentExecution))
    record_property("committed_outcome", json.dumps({
        "first": first_operation, "legacy_operation": legacy_operation, "serialization": serialization,
        "activation_status": activated.status_code, "legacy_status": legacy_result.status_code,
        "required_policy": required, "execution_count": count,
    }))
    assert serialization in {"waited", "refused"}, "A successful second operation overtook the first uncommitted decision"
    if first_operation == "activation":
        assert activated.status_code == 200 and required, activated.text
        assert legacy_result.status_code == 409, legacy_result.text
        allowed = {"context_dispatch_version_required"}
        if serialization == "refused":
            allowed.add("context_dispatch_policy_busy")
        assert allowed & finding_codes(legacy_result)
        assert count == 0
    elif legacy_operation != "assignment":
        assert legacy_result.status_code == 201, legacy_result.text
        assert activated.status_code == 409, activated.text
        allowed = {"context_dispatch_legacy_execution_active"}
        if serialization == "refused":
            allowed.add("context_dispatch_policy_busy")
        assert allowed & finding_codes(activated)
        assert not required and count == 1
    else:
        assert legacy_result.status_code == 200 and count == 0, legacy_result.text
        # A scheduler hold is not a running execution. Activation may safely
        # commit after it, or refuse pending legacy work atomically.
        assert activated.status_code in {200, 409}, activated.text
        if activated.status_code == 200:
            assert required
            late = await d.case.http.post(f"/api/agents/{d.case.agent_id}/executions",
                json=d.case.start_payload(legacy_result.json()), headers=d.headers(version=None))
            assert late.status_code == 409, late.text
            assert "context_dispatch_version_required" in finding_codes(late)
            async with d.case.factory() as db:
                assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 0
        else:
            assert not required
