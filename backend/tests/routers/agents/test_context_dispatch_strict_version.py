# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integer-valued JSON floats must not negotiate an integer-only protocol."""

import asyncio
import uuid

import pytest
from sqlalchemy import func, select

from app.core.event_bus import event_bus
from app.models.agents.context_receipt import ExecutionContextBinding, ExecutionContextReceipt
from app.models.agents.execution import AgentExecution
from app.models.agents.reservation import AgentReservation
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def counts(d):
    async with d.case.factory() as db:
        return {model.__name__: await db.scalar(select(func.count()).select_from(model)) for model in
                [AgentReservation, AgentExecution, ExecutionContextBinding, ExecutionContextReceipt]}


@pytest.mark.parametrize("operation", ["assignment", "start"])
async def test_float_protocol_version_refuses_scheduling_without_side_effects(dispatch_case, operation):
    d = dispatch_case
    await d.enroll()
    contract = await d.contract()
    assert contract.status_code == 200, contract.text
    if operation == "assignment":
        path = d.agent_path() + "/next-assignment"
        payload = {"board_id": d.case.board_id, "context_dispatch_version": 1.0,
                   "context_dispatch_policy_revision": contract.json()["policy_revision"]}
    else:
        assignment = await d.assignment()
        assert assignment.status_code == 200, assignment.text
        path = f"/api/agents/{d.case.agent_id}/executions"
        payload = d.case.start_payload(assignment.json(), context_dispatch_version=1.0,
                                       context_dispatch_policy_revision=contract.json()["policy_revision"])
    before = await counts(d)
    response = await d.case.http.post(path, json=payload, headers=d.headers())
    assert response.status_code == 422, response.text
    assert await counts(d) == before


@pytest.mark.parametrize("field", ["protocol_version", "channel_version"])
async def test_float_preparation_version_refuses_receipt_and_event(dispatch_case, field):
    d = dispatch_case
    _, execution, _ = await d.bound()
    payload = d.payload(await d.current(execution))
    if field == "protocol_version":
        payload[field] = 1.0
    else:
        payload["channel_contract"] = {**payload["channel_contract"], "version": 1.0}
    before = await counts(d)
    published = []

    async def receive(event):
        published.append(event)

    unsubscribe = event_bus.subscribe(receive, workspace_id=uuid.UUID(d.case.workspace["id"]),
                                      event_pattern="execution.context_receipt_created")
    try:
        response = await d.prepare(execution, payload)
        observed = await counts(d)
        await asyncio.sleep(0.01)
        assert response.status_code == 422, {"status": response.status_code, "before": before,
                                             "after": observed, "published": len(published)}
        assert observed == before and published == []
    finally:
        unsubscribe()


async def test_integer_protocol_control_negotiates_binds_and_prepares(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    payload = d.payload(await d.current(execution))
    assert type(payload["protocol_version"]) is type(payload["channel_contract"]["version"]) is int
    response = await d.prepare(execution, payload)
    assert response.status_code == 201, response.text
    assert response.json()["acknowledged"] == "prepared"
    observed = await counts(d)
    assert observed["AgentExecution"] == observed["ExecutionContextBinding"] == observed["ExecutionContextReceipt"] == 1
