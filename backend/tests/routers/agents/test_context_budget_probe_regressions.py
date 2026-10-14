# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regressions for root probes A, B and C."""

import copy

import pytest

from tests.routers.agents.context_budget_policy_support import (
    SECOND,
    assert_finding,
    assert_policy,
    assert_write_unchanged,
    findings,
)
from tests.routers.agents.context_budgets_support import DEFAULT_POLICY
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


def _paramless_second_step(pipeline):
    two_steps(pipeline)
    pipeline["stages"][0]["lifecycle"][1].pop("params")


async def test_probe_b_legacy_paramless_named_step_still_dispatches(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(_paramless_second_step)
    snapshot = await d.current(execution, SECOND)
    assert snapshot["context_manifest"]["schema_version"] == 1


async def test_probe_b_budgeted_paramless_named_step_resolves_as_empty_params(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()

    def configure(p):
        _paramless_second_step(p)
        p["context_budget"] = {}

    await d.store(configure)
    assert_policy(await d.current(execution, SECOND), DEFAULT_POLICY)


async def test_probe_b_malformed_step_params_fail_closed_with_findings(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()

    def configure(p):
        two_steps(p)
        p["stages"][0]["lifecycle"][1]["params"] = "not-an-object"
        p["context_budget"] = {}

    await d.store(configure)
    for response in [await d.snapshot(execution, SECOND), await d.assignment()]:
        assert response.status_code == 409, response.text[:300]
        assert response.json()["error_code"] == "context_budget_invalid"
        assert_finding(findings(response), "context_budget_invalid", "stages[0].lifecycle[1].params")


async def test_probe_c_non_object_source_under_a_budget_fails_closed_without_reindexing(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()

    def configure(p):
        sources = p["stages"][0]["llm"]["context_sources"]
        p["stages"][0]["llm"]["context_sources"] = [sources[0], 7, sources[1]]
        p["context_budget"] = {}

    await d.store(configure)
    refreshed = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context",
                                      headers=d.headers())
    for response in [await d.snapshot(execution), refreshed]:
        assert response.status_code == 409, response.text[:300]
        assert response.json()["error_code"] == "context_budget_invalid"
        assert_finding(findings(response), "context_budget_invalid", "stages[0].llm.context_sources[1]")


async def test_probe_a_inheriting_step_below_stage_cap_is_refused_at_write(dispatch_case):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["stages"][0]["llm"]["context_sources"][0]["max_rendered_bytes"] = 1024
    two_steps(pipeline)
    params = pipeline["stages"][0]["lifecycle"][1]["params"]
    params.pop("context_sources")
    params["context_budget"] = {"max_optional_note_bytes": 256, "max_managed_context_bytes": 512}
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    entry = assert_finding(findings(response), "context_budget_ceiling_exceeded",
                           "stages[0].llm.context_sources[0].max_rendered_bytes")
    assert (entry["params"]["limit"], entry["params"]["effective_value"]) == (512, 1024)
    await assert_write_unchanged(d, before)
