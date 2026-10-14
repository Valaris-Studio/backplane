# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regressions (root residual at 46a964e8): under a
budget, a present non-list context_sources fails closed at its exact path on
A2 dispatch, A1 refresh and negotiation; absent inherits, [] selects nothing,
and unbudgeted pipelines keep their legacy result."""

import copy

import pytest

from tests.routers.agents.context_budget_policy_support import (
    SECOND,
    assert_finding,
    assert_write_unchanged,
    findings,
)
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)
from tests.routers.agents.context_receipts_support import ALIAS

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]

NON_LISTS = [{"kind": "card_notes"}, "notes", 7, "", 0, {}, None]


async def _refuses(d, execution, invocation, path):
    responses = [await d.snapshot(execution, invocation), await d.assignment()]
    if invocation is None:
        responses.append(await d.case.http.get(
            d.case.execution_path(execution["id"]) + "/context", headers=d.headers()))
    for response in responses:
        assert response.status_code == 409, response.text[:300]
        assert response.json()["error_code"] == "context_budget_invalid"
        assert_finding(findings(response), "context_budget_invalid", path)


@pytest.mark.parametrize("value", NON_LISTS)
async def test_budgeted_stage_non_list_sources_fail_closed(dispatch_case, value):
    d = dispatch_case
    _, execution, _ = await d.bound()

    def configure(p):
        p["context_budget"] = {}
        p["stages"][0]["llm"]["context_sources"] = value

    await d.store(configure)
    await _refuses(d, execution, None, "stages[0].llm.context_sources")


@pytest.mark.parametrize("value", NON_LISTS)
async def test_budgeted_step_non_list_sources_fail_closed(dispatch_case, value):
    d = dispatch_case
    _, execution, _ = await d.bound()

    def configure(p):
        p["context_budget"] = {}
        two_steps(p)
        p["stages"][0]["lifecycle"][1]["params"]["context_sources"] = value

    await d.store(configure)
    await _refuses(d, execution, SECOND, "stages[0].lifecycle[1].params.context_sources")


@pytest.mark.parametrize("step_sources", ["absent", "empty"])
async def test_budgeted_step_absent_inherits_and_empty_selects_nothing(dispatch_case, step_sources):
    d = dispatch_case
    _, execution, _ = await d.bound()

    def configure(p):
        p["context_budget"] = {}
        two_steps(p)
        params = p["stages"][0]["lifecycle"][1]["params"]
        if step_sources == "absent":
            params.pop("context_sources")
        else:
            params["context_sources"] = []

    await d.store(configure)
    snapshot = await d.current(execution, SECOND)
    assert snapshot["context_manifest"]["schema_version"] == 2
    if step_sources == "absent":
        assert ALIAS in snapshot["context"]
    else:
        assert snapshot["context_manifest"]["sources"] == []


@pytest.mark.parametrize("value", NON_LISTS)
async def test_unbudgeted_non_list_sources_keep_the_legacy_result(dispatch_case, value):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(lambda p: p["stages"][0]["llm"].update(context_sources=value))
    snapshot = await d.current(execution)
    assert snapshot["context_manifest"]["schema_version"] == 1
    assert snapshot["context_manifest"]["sources"] == []


async def test_budgeted_non_list_sources_write_is_refused_unchanged(dispatch_case):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["context_budget"] = {}
    pipeline["stages"][0]["llm"]["context_sources"] = {"kind": "card_notes"}
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    await assert_write_unchanged(d, before)
