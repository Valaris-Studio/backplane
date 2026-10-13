# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent A2 floor guards for direct legacy calls and strict wire versions."""

import pytest
from sqlalchemy import func, select

from app.models.agents.execution import AgentExecution
from app.models.agents.reservation import AgentReservation
from tests.routers.agents.context_dispatch_support import (
    HEADER,
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def holds(d):
    async with d.case.factory() as db:
        return [dict(row) for row in (await db.execute(select(AgentReservation.__table__).order_by(AgentReservation.id))).mappings()]


async def executions(d):
    async with d.case.factory() as db:
        return await db.scalar(select(func.count()).select_from(AgentExecution))


@pytest.mark.parametrize("versioned", [False, True])
async def test_required_floor_cannot_be_bypassed_by_direct_start_without_reservation(dispatch_case, versioned):
    d = dispatch_case
    assignment = await d.case.assignment()
    payload = d.case.start_payload(assignment)
    payload.pop("reservation_id")
    await d.enroll()
    if versioned:
        contract = await d.contract()
        assert contract.status_code == 200, contract.text
        payload.update(context_dispatch_version=1,
                       context_dispatch_policy_revision=contract.json()["policy_revision"])
    response = await d.case.http.post(f"/api/agents/{d.case.agent_id}/executions", json=payload,
                                     headers=d.headers(version="1" if versioned else None))
    assert response.status_code == 409, response.text
    expected = "context_dispatch_binding_required" if versioned else "context_dispatch_version_required"
    assert expected in finding_codes(response)
    assert await executions(d) == 0


async def test_legacy_direct_start_without_negotiation_remains_supported(dispatch_case):
    d = dispatch_case
    assignment = await d.case.assignment()
    direct = d.case.start_payload(assignment)
    direct.pop("reservation_id")
    legacy = await d.case.http.post(f"/api/agents/{d.case.agent_id}/executions", json=direct,
                                   headers=d.headers(version=None))
    assert legacy.status_code == 201, legacy.text
    assert await executions(d) == 1


async def test_required_versioned_bound_start_retains_positive_negotiation_control(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    stamp = execution["context_binding"].get("context_dispatch")
    assert stamp is not None, "A versioned required start must retain its negotiated floor"
    assert stamp["version"] == 1 and stamp["mode"] == "required"


@pytest.mark.parametrize("route", ["assignment", "start"])
@pytest.mark.parametrize("body_version,header_version", [
    (True, "1"), ("1", "1"), (1, "2"), (2, "1"),
])
async def test_protocol_version_is_strict_and_header_body_disagreement_has_no_side_effects(
    dispatch_case, route, body_version, header_version,
):
    d = dispatch_case
    assignment = await d.case.assignment()
    await d.enroll()
    payload = ({"board_id": d.case.board_id} if route == "assignment" else d.case.start_payload(assignment))
    payload.update(context_dispatch_version=body_version, context_dispatch_policy_revision="0" * 64)
    path = (d.agent_path() + "/next-assignment" if route == "assignment"
            else f"/api/agents/{d.case.agent_id}/executions")
    headers = {**d.headers(), HEADER: header_version}
    before_holds = await holds(d)
    response = await d.case.http.post(path, json=payload, headers=headers)
    assert response.status_code == 422, response.text
    assert await executions(d) == 0
    assert await holds(d) == before_holds


@pytest.mark.parametrize("body_version,header_version", [(True, "1"), ("1", "1"), (1, "2"), (2, "1")])
async def test_preparation_protocol_version_uses_the_same_strict_wire_contract(
    dispatch_case, body_version, header_version,
):
    d = dispatch_case
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    payload = d.payload(snapshot, protocol_version=body_version)
    response = await d.case.http.post(d.case.execution_path(execution["id"]) + "/dispatch-preparations",
        json=payload, headers={**d.headers(), HEADER: header_version})
    assert response.status_code == 422, response.text
    history = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                    headers=d.headers("recipient"))
    assert history.status_code == 200 and history.json() == []
