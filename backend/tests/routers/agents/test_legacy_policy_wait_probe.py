# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A committed revocation during the new policy wait cannot admit legacy work."""

import asyncio
import json
import uuid
import pytest
from sqlalchemy import func, select, text, update
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.agents.reservation import AgentReservation
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_dispatch_floor_postgres import floor_http  # noqa: F401
from tests.routers.agents.test_context_dispatch_review_paused_poll_postgres import (
    _wait_blocked_by,
)
from tests.routers.agents.test_context_receipts_postgres import db_engine  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]


@pytest.mark.parametrize("operation", ["poll", "direct_start"])
@pytest.mark.parametrize("revocation", ["none", "inactive", "scope"])
async def test_legacy_operation_rechecks_authority_after_policy_wait(
    floor_http, operation, revocation, record_property  # noqa: F811
):
    f, d = floor_http, floor_http.dispatch
    if operation == "poll":
        path = d.agent_path() + "/next-assignment"
        payload = {"board_id": d.case.board_id}
    else:
        assignment = await d.case.assignment()
        payload = d.case.start_payload(assignment)
        payload.pop("reservation_id")
        path = f"/api/agents/{d.case.agent_id}/executions"
    request = None
    async with d.case.factory() as blocker:
        try:
            await blocker.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:k,0))"),
                {"k": f'context-dispatch-policy:{d.case.workspace["id"]}'},
            )
            blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
            request = asyncio.create_task(
                d.case.http.post(
                    path,
                    json=payload,
                    headers={**d.headers(version=None), **f.gate.arm(1)},
                )
            )
            await _wait_blocked_by(f, blocker_pid, request, record_property)
            async with d.case.factory() as mutation:
                mutation_pid = await mutation.scalar(text("SELECT pg_backend_pid()"))
                # Authentication may commit and return its earlier PID to the pool.
                # Distinguish the live blocked transaction, not every old PID.
                blocked_pids = (
                    (
                        await mutation.execute(
                            text(
                                "SELECT pid FROM pg_stat_activity WHERE application_name=:tag "
                                "AND wait_event_type='Lock' AND :blocker=ANY(pg_blocking_pids(pid))"
                            ),
                            {"tag": f.gate.application_name, "blocker": blocker_pid},
                        )
                    )
                    .scalars()
                    .all()
                )
                assert len(blocked_pids) == 1
                assert mutation_pid != blocker_pid and mutation_pid not in blocked_pids
                if revocation != "none":
                    changes = (
                        {"is_active": False}
                        if revocation == "inactive"
                        else {"allowed_workspaces": ["foreign"]}
                    )
                    await mutation.execute(
                        update(Agent)
                        .where(Agent.id == uuid.UUID(d.case.agent_id))
                        .values(**changes)
                    )
                await mutation.commit()
            record_property(
                "committed_before_release",
                json.dumps(
                    {
                        "revocation": revocation,
                        "mutation_pid": mutation_pid,
                        "blocker_pid": blocker_pid,
                    }
                ),
            )
            await blocker.rollback()
            response = await asyncio.wait_for(request, 10)
        finally:
            await blocker.rollback()
            if request and not request.done():
                request.cancel()
            if request:
                await asyncio.gather(request, return_exceptions=True)
    async with d.case.factory() as db:
        executions = await db.scalar(select(func.count()).select_from(AgentExecution))
        holds = await db.scalar(select(func.count()).select_from(AgentReservation))
    observed = {
        "operation": operation,
        "revocation": revocation,
        "status": response.status_code,
        "executions": executions,
        "holds": holds,
    }
    record_property("observation", json.dumps(observed))
    if revocation == "none":
        assert response.status_code == (200 if operation == "poll" else 201), observed
        assert executions == (0 if operation == "poll" else 1), observed
    else:
        assert response.status_code == 403, observed
        assert executions == 0, observed
        if operation == "poll":
            assert holds == 0, observed
