# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Current start authority across an actual pending policy-writer transaction."""

import asyncio
import copy
import json
import uuid

import pytest
from sqlalchemy import delete, func, select, text, update

from app.models.agents.agent import Agent
from app.models.agents.context_receipt import ExecutionContextBinding
from app.models.agents.execution import AgentExecution
from app.models.workspace import WorkspaceMember
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)
from tests.routers.agents.test_context_dispatch_floor_postgres import (
    floor_http as _floor_http_fixture,
    observe_second_transaction,
)
from tests.routers.agents.test_context_receipts_postgres import db_engine  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.timeout(45)]
floor_http = _floor_http_fixture


async def revoke_on_third_connection(case, kind, writer_pid, request_pids):
    async with case.factory() as db:
        pid = await db.scalar(text("SELECT pg_backend_pid()"))
        assert pid != writer_pid and pid not in request_pids
        if kind == "membership":
            await db.execute(delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == uuid.UUID(case.workspace["id"]),
                WorkspaceMember.user_id == uuid.UUID(case.recipient_id),
            ))
        elif kind != "none":
            changes = {"is_active": False} if kind == "agent_inactive" else {"allowed_workspaces": ["foreign"]}
            await db.execute(update(Agent).where(Agent.id == uuid.UUID(case.agent_id)).values(**changes))
        await db.commit()
        return pid


@pytest.mark.parametrize("operation", ["fresh_promotion", "existing_binding_replay"])
@pytest.mark.parametrize("revocation", ["none", "membership", "agent_scope", "agent_inactive"])
async def test_required_start_authority_survives_pending_policy_writer(
    floor_http, operation, revocation, record_property,
):
    f, d = floor_http, floor_http.dispatch
    await d.enroll()
    response = await d.assignment()
    assert response.status_code == 200, response.text
    assignment = response.json()
    payload = d.case.start_payload(assignment, context_dispatch_version=1,
                                  context_dispatch_policy_revision=assignment["context_dispatch"]["policy_revision"])
    path = f"/api/agents/{d.case.agent_id}/executions"
    existing = None
    if operation == "existing_binding_replay":
        response = await d.case.http.post(path, json=payload, headers=d.headers("recipient"))
        assert response.status_code == 201, response.text
        existing = response.json()["id"]

    current = await d.config()
    pipeline = copy.deepcopy(current["pipeline_config"])
    pipeline["operator_extension"] = {"synthetic_authority_probe": True}
    # A real authorized config request owns whichever production locks serialize
    # policy writes. Only its outer commit is held; no lock helper is replaced.
    writer = asyncio.create_task(d.case.http.patch(
        d.config_path,
        json={"pipeline_config": pipeline, "expected_version": current["version"]},
        headers={**d.headers("recipient"), "X-A2-Hold-Before-Commit": f.hold.token},
    ))
    arrived = asyncio.create_task(f.hold.arrived.wait())
    start = None
    serialization = None
    try:
        done, _ = await asyncio.wait({writer, arrived}, timeout=8, return_when=asyncio.FIRST_COMPLETED)
        assert arrived in done, (await writer).text if writer.done() else "Config writer never reached outer commit"
        if existing is not None:
            # Existing bindings currently bypass the policy lock. Revoke before
            # replay, and do not describe this as a post-lock authority proof.
            mutation_pid = await revoke_on_third_connection(d.case, revocation, f.hold.pid, [])
        start = asyncio.create_task(d.case.http.post(
            path, json=payload, headers={**d.headers("recipient"), **f.gate.arm(1)},
        ))
        await asyncio.wait_for(f.gate.arrived.wait(), 5)
        serialization = await observe_second_transaction(f, start, record_property)
        if existing is None:
            assert serialization in {"waited", "refused"}, "Fresh start overtook uncommitted policy writer"
            mutation_pid = await revoke_on_third_connection(
                d.case, revocation, f.hold.pid, f.gate.transaction_pids,
            )
        record_property("mutation_committed_before_writer_release", json.dumps({
            "kind": revocation, "pid": mutation_pid, "writer_pid": f.hold.pid,
            "request_transaction_pids": list(f.gate.transaction_pids),
            "replay_has_no_post_guard_claim": existing is not None,
        }))
        f.hold.release.set()
        written, response = await asyncio.wait_for(asyncio.gather(writer, start), 10)
        assert written.status_code == 200, written.text
    finally:
        f.hold.release.set()
        for task in [arrived, writer, start]:
            if task is not None and not task.done():
                task.cancel()
        await asyncio.gather(*[t for t in [arrived, writer, start] if t is not None], return_exceptions=True)

    async with d.case.factory() as db:
        executions = await db.scalar(select(func.count()).select_from(AgentExecution))
        bindings = await db.scalar(select(func.count()).select_from(ExecutionContextBinding))
    observed = {"operation": operation, "revocation": revocation, "serialization": serialization,
                "status": response.status_code, "executions": executions, "bindings": bindings}
    record_property("committed_result", json.dumps(observed))
    if serialization == "refused":
        assert response.status_code == 409 and "context_dispatch_policy_busy" in finding_codes(response), response.text
        assert executions == bindings == (1 if existing else 0)
    elif revocation != "none":
        assert response.status_code == 403, observed
        assert "id" not in response.json()
        assert executions == bindings == (1 if existing else 0), observed
    else:
        assert response.status_code == (200 if existing else 201), observed
        assert executions == bindings == 1, observed
        if existing:
            assert response.json()["id"] == existing
