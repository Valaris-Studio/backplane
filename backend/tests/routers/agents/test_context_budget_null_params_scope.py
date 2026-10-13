# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored (root decision, option a): a named step stored with
`params: null` is refused only when that invocation is itself opted in —
through the workspace or stage budget (present, even if invalid) or an
inherited stage source cap. Another step's budget does not invent an invalid
budget on a legacy invocation."""

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

PARAMS = "stages[0].lifecycle[1].params"


def _null_second_params(pipeline, opt_in):
    two_steps(pipeline)
    steps = pipeline["stages"][0]["lifecycle"]
    steps[1]["params"] = None
    if opt_in == "unrelated_step":
        steps[0]["params"]["context_budget"] = {}
    elif opt_in == "workspace":
        pipeline["context_budget"] = {}
    elif opt_in == "workspace_null":
        pipeline["context_budget"] = None
    elif opt_in == "stage":
        pipeline["stages"][0]["llm"]["context_budget"] = {}
    elif opt_in == "stage_invalid":
        pipeline["stages"][0]["llm"]["context_budget"] = "not-a-policy"
    elif opt_in == "inherited_cap":
        pipeline["stages"][0]["llm"]["context_sources"][0]["max_rendered_bytes"] = 1024


async def test_unrelated_step_budget_leaves_a_null_params_step_legacy(dispatch_case):
    d = dispatch_case
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    _null_second_params(pipeline, "unrelated_step")
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution, SECOND)
    assert snapshot["context_manifest"]["schema_version"] == 1


@pytest.mark.parametrize("opt_in", ["workspace", "workspace_null", "stage", "stage_invalid", "inherited_cap"])
async def test_opted_in_null_params_step_is_refused_on_write(dispatch_case, opt_in):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    _null_second_params(pipeline, opt_in)
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    assert_finding(findings(response), "context_budget_invalid", PARAMS)
    await assert_write_unchanged(d, before)


@pytest.mark.parametrize("opt_in", ["workspace", "workspace_null", "stage", "stage_invalid", "inherited_cap"])
async def test_opted_in_null_params_step_refuses_dispatch(dispatch_case, opt_in):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(lambda p: _null_second_params(p, opt_in))
    response = await d.snapshot(execution, SECOND)
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "context_budget_invalid"
    assert len(response.content) <= 4096
    assert_finding(findings(response), "context_budget_invalid", PARAMS)


async def test_valid_params_controls_resolve(dispatch_case):
    d = dispatch_case
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    two_steps(pipeline)
    pipeline["context_budget"] = {}
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    _, execution, _ = await d.bound(required=False)
    assert_policy(await d.current(execution, SECOND), DEFAULT_POLICY)
