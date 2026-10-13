# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression (review L1), adapted from the reviewer's
probe: a legacy unversioned poll that waits on the shared context-dispatch
policy lock must honour a pause committed during that wait. The router loads
the agent before the wait, so the scheduler must see a fresh row after it."""

import asyncio
import json
import uuid

import pytest
from sqlalchemy import func, select, text, update

from app.models.agents.agent import Agent
from app.models.agents.reservation import AgentReservation
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_dispatch_floor_postgres import (
    floor_http as _floor_http_fixture,
)
from tests.routers.agents.test_context_receipts_postgres import db_engine  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.timeout(60)]
floor_http = _floor_http_fixture


async def _wait_blocked_by(f, blocker_pid, request, record_property):
    async with asyncio.timeout(10):
        while True:
            if request.done():
                response = await request
                pytest.fail(f"poll finished before waiting: {response.status_code} {response.text}")
            async with f.dispatch.case.factory() as db:
                rows = (await db.execute(text(
                    "SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers "
                    "FROM pg_stat_activity WHERE application_name = :tag AND datname = current_database()"
                ), {"tag": f.gate.application_name})).mappings().all()
            for row in rows:
                if row["wait_event_type"] == "Lock" and blocker_pid in row["blockers"]:
                    record_property("blocked", json.dumps({
                        "pid": row["pid"], "wait_event": row["wait_event"],
                        "blockers": list(row["blockers"]), "owned_blocker_pid": blocker_pid,
                    }))
                    return
            await asyncio.sleep(0.01)


async def test_legacy_poll_honours_pause_committed_during_policy_wait(floor_http, record_property):
    f, d = floor_http, floor_http.dispatch
    policy_key = f"context-dispatch-policy:{uuid.UUID(d.case.workspace['id'])}"
    blocker = await d.case.factory().__aenter__()
    try:
        await blocker.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": policy_key})
        blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
        poll = asyncio.create_task(d.case.http.post(
            d.agent_path() + "/next-assignment", json={"board_id": d.case.board_id},
            headers={**d.headers(version=None), **f.gate.arm(1)}))
        await _wait_blocked_by(f, blocker_pid, poll, record_property)
        async with d.case.factory() as db:
            await db.execute(update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(is_paused=True))
            await db.commit()
        record_property("pause_committed_before_release", "true")
    finally:
        await blocker.rollback()
        await blocker.close()
    response = await asyncio.wait_for(poll, 15)
    async with d.case.factory() as db:
        reservations = await db.scalar(select(func.count()).select_from(AgentReservation))
    record_property("outcome", json.dumps({"status": response.status_code, "reservations": reservations}))
    assert response.status_code == 204, response.text
    assert reservations == 0
