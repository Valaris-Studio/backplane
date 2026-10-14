# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent A1 lock-boundary regressions using actual HTTP and PostgreSQL.

The imported disposable-schema fixture requires an explicit local test DB.
No authentication, production service, clock, or SQL operation is mocked.
"""

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select, text, update

from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.agents.reservation import AgentReservation
from app.models.kanban.board import Board
from app.models.workspace import WorkspaceMember
from app.schemas.agents.execution import ExecutionCreate
from app.services.agents.execution import ExecutionService
from tests.routers.agents.context_receipts_support import (
    ALIAS,
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_receipts_postgres import (
    db_engine,  # noqa: F401
    execution_count,
    history,
    pg_http as _pg_http_fixture,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]
pg_http = _pg_http_fixture


@asynccontextmanager
async def blocked_http_post(pg_http, path, payload, blocker_pid, record_property, *, actor="agent"):
    case, gate = pg_http.case, pg_http.gate
    headers = {**case.headers[actor], **gate.arm(1)}
    task = asyncio.create_task(case.http.post(path, json=payload, headers=headers))
    try:
        await asyncio.wait_for(gate.arrived.wait(), 5)
        assert len(gate.pids) == 1
        initial_pid = next(iter(gate.pids))
        assert initial_pid != blocker_pid
        async with asyncio.timeout(5):
            while True:
                # A new transaction avoids PostgreSQL's statistics snapshot
                # cache while observing the real request's lock wait.
                async with case.factory() as observer:
                    rows = (await observer.execute(text(
                        "SELECT pid, application_name, state, wait_event_type, wait_event, query, "
                        "pg_blocking_pids(pid) AS blockers FROM pg_stat_activity "
                        "WHERE datname = current_database() AND application_name = :name"
                    ), {"name": gate.application_name})).mappings().all()
                assert len(rows) <= 1, "One tagged HTTP request has multiple active transactions"
                if rows:
                    row = rows[0]
                    assert row["pid"] in gate.transaction_pids
                    if row["wait_event_type"] == "Lock" and blocker_pid in row["blockers"]:
                        record_property("blocked_request", json.dumps({
                            "owned_blocker_pid": blocker_pid, "initial_request_pid": initial_pid,
                            "observed_transaction_pids": gate.transaction_pids, **dict(row),
                        }))
                        break
                assert not task.done(), "Request finished without waiting on the owned row lock"
                await asyncio.sleep(0.01)
        yield task
    finally:
        if not task.done():
            task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def commit_revocation(case, revocation):
    async with case.factory() as db:
        if revocation == "membership":
            await db.execute(delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == uuid.UUID(case.workspace["id"]),
                WorkspaceMember.user_id == uuid.UUID(case.recipient_id),
            ))
        elif revocation != "none":
            values = ({"allowed_workspaces": ["foreign"]} if revocation == "agent_scope"
                      else {"is_active": False})
            await db.execute(update(Agent).where(
                Agent.id == uuid.UUID(case.agent_id)
            ).values(**values))
        await db.commit()


@pytest.mark.parametrize("invocation", ["exact_replay", "fresh_key"])
@pytest.mark.parametrize("revocation", ["none", "membership", "agent_scope", "agent_inactive"])
async def test_preparation_rechecks_authority_after_execution_lock_wait(
    pg_http, invocation, revocation, record_property,
):
    case = pg_http.case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    path = case.execution_path(execution["id"]) + "/context-receipts"
    original_payload = case.receipt_payload(assignment)
    created = await case.http.post(path, json=original_payload, headers=case.headers["agent"])
    assert created.status_code == 201, created.text
    original = (await case.receipt(execution, created.json()["id"], actor="curator")).json()
    payload = original_payload if invocation == "exact_replay" else case.receipt_payload(assignment)

    async with case.factory() as blocker:
        blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
        await blocker.scalar(select(AgentExecution).where(
            AgentExecution.id == uuid.UUID(execution["id"])
        ).with_for_update())
        # The plain owner key remains valid after its agent is deactivated;
        # this tests bound-agent authorization in the service, not key auth.
        async with blocked_http_post(
            pg_http, path, payload, blocker_pid, record_property, actor="recipient",
        ) as request:
            await commit_revocation(case, revocation)
            await blocker.commit()
            response = await asyncio.wait_for(request, 10)

    retained = await case.receipt(execution, original["id"], actor="curator")
    assert retained.status_code == 200 and retained.json() == original
    listed = await case.http.get(path, headers=case.headers["curator"])
    assert listed.status_code == 200
    actual_count = int(listed.headers["X-Total-Count"])
    observed = {"status": response.status_code, "receipt_count": actual_count,
                "historical_snapshot_unchanged": True}
    record_property("result", json.dumps(observed))
    if revocation == "none":
        expected_count = 1 if invocation == "exact_replay" else 2
        assert response.status_code == (200 if invocation == "exact_replay" else 201), observed
        assert actual_count == expected_count
    else:
        assert response.status_code == 403, observed
        assert ALIAS not in response.text
        assert actual_count == 1, "A revoked caller must not create an invocation receipt"


@pytest.mark.parametrize("field", ["role", "card_id", "board_id", "input_summary"])
async def test_promoted_hold_keeps_tuple_mismatch_opaque(pg_http, field, record_property):
    case = pg_http.case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    async with case.factory() as db:
        original_board = await db.get(Board, uuid.UUID(case.board_id))
        other_board = Board(workspace_id=original_board.workspace_id,
                            name="Other authorized board", slug="other-authorized",
                            created_by=original_board.created_by)
        db.add(other_board)
        await db.commit()
        other_board_id = str(other_board.id)
    changes = {"role": "different_operator_role", "card_id": case.other_card_id,
               "board_id": other_board_id, "input_summary": "Different invocation summary"}
    path = f"/api/agents/{case.agent_id}/executions"
    payload = case.start_payload(assignment, **{field: changes[field]})
    response = await case.http.post(path, json=payload, headers=case.headers["agent"])
    unknown = await case.http.post(
        path, json={**payload, "reservation_id": str(uuid.uuid4())}, headers=case.headers["agent"],
    )
    assert unknown.status_code == 404
    replay = await case.http.post(path, json=case.start_payload(assignment), headers=case.headers["agent"])
    assert replay.status_code == 200 and replay.json()["id"] == execution["id"]
    assert await execution_count(case) == 1
    record_property("result", json.dumps({
        "field": field, "status": response.status_code, "error": response.json(),
        "unknown": unknown.json(), "exact_replay_status": replay.status_code,
        "execution_count": 1,
    }))
    if field == "input_summary":
        assert response.status_code == 409, response.text
        assert response.json()["error_code"] == "execution_start_conflict"
    else:
        assert response.status_code == 404, response.text
        assert response.json() == unknown.json()


@pytest.mark.parametrize("hold_state", ["expires_while_waiting", "deleted_at_promotion_commit"])
async def test_waiting_exact_start_replays_committed_binding_without_a_live_hold(
    pg_http, hold_state, record_property,
):
    case = pg_http.case
    assignment = await case.assignment()
    reservation_id = uuid.UUID(assignment["reservation"]["id"])
    expires_at = datetime.now(UTC).replace(tzinfo=None) + timedelta(seconds=3)
    async with case.factory() as db:
        await db.execute(update(AgentReservation).where(
            AgentReservation.id == reservation_id
        ).values(expires_at=expires_at))
        await db.commit()

    payload = case.start_payload(assignment)
    path = f"/api/agents/{case.agent_id}/executions"
    async with case.factory() as promoter:
        blocker_pid = await promoter.scalar(text("SELECT pg_backend_pid()"))
        # The real service creates the winning execution/binding inside this
        # owned outer transaction; the HTTP retry cannot see it until commit.
        execution, created = await ExecutionService(promoter).start_bound_execution(
            uuid.UUID(case.agent_id), ExecutionCreate(**payload),
            user_id=uuid.UUID(case.recipient_id),
        )
        assert created
        execution_id = str(execution.id)
        promoted_at = datetime.now(UTC).replace(tzinfo=None)
        assert promoted_at < expires_at
        assert await execution_count(case) == 0, "Winning promotion committed unexpectedly"
        async with blocked_http_post(
            pg_http, path, payload, blocker_pid, record_property,
        ) as request:
            if hold_state == "expires_while_waiting":
                remaining = (expires_at - datetime.now(UTC).replace(tzinfo=None)).total_seconds()
                await asyncio.sleep(max(0, remaining) + 0.02)
                assert datetime.now(UTC).replace(tzinfo=None) > expires_at
            else:
                await promoter.execute(delete(AgentReservation).where(
                    AgentReservation.id == reservation_id
                ))
            await promoter.commit()
            committed_at = datetime.now(UTC).replace(tzinfo=None)
            response = await asyncio.wait_for(request, 10)

    # A later retry observes exactly the same binding and succeeds, proving
    # the failure is the wait/re-read boundary, not an invalid assignment.
    later = await case.http.post(path, json=payload, headers=case.headers["agent"])
    assert later.status_code == 200 and later.json()["id"] == execution_id, later.text
    assert await execution_count(case) == 1
    await history(case, {"id": execution_id}, 0)
    record_property("result", json.dumps({
        "hold_state": hold_state, "waiting_status": response.status_code,
        "waiting_error": response.json().get("error_code"), "later_status": later.status_code,
        "execution_count": 1, "promoted_at": promoted_at.isoformat() + "Z",
        "expires_at": expires_at.isoformat() + "Z", "committed_at": committed_at.isoformat() + "Z",
    }))
    assert response.status_code == 200, response.text
    assert response.json()["id"] == execution_id
