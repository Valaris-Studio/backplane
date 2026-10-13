# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored: the policy lock's ordering never deadlocks over real
PostgreSQL connections. Polls (shared policy lock, then reservation and
workspace rows FOR UPDATE), starts (shared, then hold, then workspace),
policy writes and bundle applies (exclusive, then workspace and config) run
concurrently; PostgreSQL would abort a cycle with 40P01, surfacing as a 500."""

import asyncio
import copy
from dataclasses import replace

import pytest

from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
)
from tests.routers.agents.test_context_receipts_postgres import (
    db_engine,  # noqa: F401
    pg_http as _pg_http_fixture,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(90)]
pg_http = _pg_http_fixture


@pytest.mark.parametrize("round_", range(5))
async def test_concurrent_polls_starts_and_policy_writes_never_deadlock(dispatch_case, pg_http, round_):
    d = replace(dispatch_case, case=pg_http.case)
    http, case = d.case.http, d.case
    config = await d.config()
    enrolled = copy.deepcopy(config["pipeline_config"])
    enrolled["context_dispatch"] = {"version": 1, "required_agent_ids": [case.agent_id]}
    exported = await http.get(d.config_path + "/bundle/export", headers=d.headers("recipient"))
    bundle = exported.json()
    bundle["data"]["pipeline_config"]["lock_roles"] = True
    contract = (await d.contract()).json()
    versioned_poll = {"board_id": case.board_id, "context_dispatch_version": 1,
                      "context_dispatch_policy_revision": contract["policy_revision"]}
    legacy_poll = {"board_id": case.board_id}
    poll = d.agent_path() + "/next-assignment"
    requests = [
        http.post(poll, json=legacy_poll, headers=d.headers(version=None)),
        http.post(poll, json=legacy_poll, headers=d.headers(version=None)),
        http.post(poll, json=versioned_poll, headers=d.headers()),
        http.patch(d.config_path, json={"pipeline_config": enrolled},
                   headers=d.headers("recipient", version=None)),
        http.post(d.config_path + "/bundle/import", params={"dry_run": False}, json=bundle,
                  headers=d.headers("recipient", version=None)),
    ]
    # Also a start promoting a hold taken just before the race.
    hold = await http.post(poll, json=legacy_poll, headers=d.headers(version=None))
    if hold.status_code == 200:
        requests.append(http.post(f"/api/agents/{case.agent_id}/executions",
                                  json=case.start_payload(hold.json()), headers=d.headers(version=None)))
    responses = await asyncio.wait_for(asyncio.gather(*requests), 60)
    assert all(r.status_code < 500 for r in responses), [(r.status_code, r.text[:300]) for r in responses]
    assert not any("deadlock" in r.text.lower() for r in responses)
