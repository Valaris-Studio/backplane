# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A2 real HTTP/PG races reuse A1's explicit local-DB and owned-schema guard."""

import asyncio
import uuid
from dataclasses import replace

import pytest
from sqlalchemy import select, text

from app.models.agents.execution import AgentExecution
from tests.routers.agents.context_dispatch_support import (
    HEADER,
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_receipts_postgres import (
    db_engine,  # noqa: F401
    pg_http as _pg_http_fixture,
)
from tests.routers.agents.test_context_receipts_review_postgres import (
    blocked_http_post,
    commit_revocation,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(40)]
pg_http = _pg_http_fixture


def over_network(dispatch_case, pg_http):
    pg_http.case = replace(pg_http.case, headers={
        actor: {**headers, HEADER: "1"} for actor, headers in pg_http.case.headers.items()
    })
    return replace(dispatch_case, case=pg_http.case)


@pytest.mark.parametrize("invocation", ["exact_replay", "fresh_key"])
@pytest.mark.parametrize("revocation", ["none", "agent_inactive"])
async def test_a2_prepare_reauthorizes_after_actual_execution_row_lock_wait(
    dispatch_case, pg_http, invocation, revocation, record_property,
):
    d = over_network(dispatch_case, pg_http)
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    original = d.payload(snapshot)
    created = await d.prepare(execution, original)
    assert created.status_code == 201, created.text
    payload = original if invocation == "exact_replay" else {**original, "client_request_id": str(uuid.uuid4())}
    path = d.case.execution_path(execution["id"]) + "/dispatch-preparations"
    async with d.case.factory() as blocker:
        pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
        await blocker.scalar(select(AgentExecution).where(
            AgentExecution.id == uuid.UUID(execution["id"]),
        ).with_for_update())
        async with blocked_http_post(pg_http, path, payload, pid, record_property, actor="recipient") as request:
            await commit_revocation(d.case, revocation)
            await blocker.commit()
            response = await asyncio.wait_for(request, 10)
    rows = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                 headers=d.headers("curator"))
    assert rows.status_code == 200
    if revocation == "none":
        assert response.status_code == (200 if invocation == "exact_replay" else 201), response.text
        assert len(rows.json()) == (1 if invocation == "exact_replay" else 2)
    else:
        assert response.status_code == 403, response.text
        assert len(rows.json()) == 1
    retained = await d.case.receipt(execution, created.json()["receipt_id"], actor="curator")
    assert retained.status_code == 200
    assert retained.json()["input_prompt"] == original["input_prompt"]


@pytest.mark.parametrize("kind", ["identical", "conflicting", "distinct"])
async def test_a2_concurrent_preparations_preserve_keys_and_unique_ordinals(dispatch_case, pg_http, kind):
    d = over_network(dispatch_case, pg_http)
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    payload = d.payload(snapshot)
    other = dict(payload)
    if kind == "conflicting":
        other["input_prompt"] += "\nA different call"
    elif kind == "distinct":
        other["client_request_id"] = str(uuid.uuid4())
    responses = await pg_http.race("POST", d.case.execution_path(execution["id"]) + "/dispatch-preparations",
                                   [payload, other])
    pg_http.assert_connections(2)
    assert sorted(r.status_code for r in responses) == {
        "identical": [200, 201], "conflicting": [201, 409], "distinct": [201, 201],
    }[kind], [r.text for r in responses]
    rows = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                 headers=d.headers("recipient"))
    assert rows.status_code == 200
    assert [row["ordinal"] for row in rows.json()] == ([2, 1] if kind == "distinct" else [1])
