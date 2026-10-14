# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regressions for the B1 phase-2 review (P2-1..P2-5)."""

import copy

import pytest

from tests.routers.agents.context_budget_policy_support import (
    SECOND,
    SMALL_POLICY,
    assert_finding,
    assert_policy,
    assert_write_unchanged,
    findings,
    install_instance,
)
from tests.routers.agents.context_budgets_support import DEFAULT_POLICY
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]

STEP_CAPS = {"max_optional_note_bytes": 1024, "max_managed_context_bytes": 4096}


def _inheriting_step_below_stage_cap(pipeline):
    pipeline["stages"][0]["llm"]["context_sources"][0]["max_rendered_bytes"] = 8192
    two_steps(pipeline)
    params = pipeline["stages"][0]["lifecycle"][1]["params"]
    params.pop("context_sources")
    params["context_budget"] = dict(STEP_CAPS)


async def test_p2_1_write_judges_a_step_against_its_inherited_source_caps(dispatch_case):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    _inheriting_step_below_stage_cap(pipeline)
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    entry = assert_finding(findings(response), "context_budget_ceiling_exceeded",
                           "stages[0].llm.context_sources[0].max_rendered_bytes")
    assert entry["params"]["limit"] == 4096 and entry["params"]["effective_value"] == 8192
    await assert_write_unchanged(d, before)


async def test_p2_1_persisted_inherited_source_cap_refuses_dispatch_with_findings(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(_inheriting_step_below_stage_cap)
    response = await d.snapshot(execution, SECOND)
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "context_budget_invalid"
    assert_finding(findings(response), "context_budget_ceiling_exceeded",
                   "stages[0].llm.context_sources[0].max_rendered_bytes")


async def test_p2_2_unrelated_pipeline_write_must_repair_a_lowered_ceiling_excess(dispatch_case, monkeypatch):
    d = dispatch_case
    await d.store(lambda p: p.update(context_budget={}))
    install_instance(monkeypatch, max_note_body_bytes=512)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["stages"][0]["llm"]["model"] = "operator-model-48-unrelated"
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    assert_finding(findings(response), "context_budget_ceiling_exceeded", "context_budget.max_note_body_bytes")
    await assert_write_unchanged(d, before)
    pipeline["context_budget"] = {"max_note_body_bytes": 512}
    repaired = await d.write(pipeline)
    assert repaired.status_code == 200, repaired.text


async def test_p2_3_only_the_invocation_that_opts_in_is_budgeted(dispatch_case):
    d = dispatch_case

    def step_only(p):
        two_steps(p)
        p["stages"][0]["lifecycle"][1]["params"]["context_budget"] = dict(SMALL_POLICY)

    _, execution, _ = await d.bound()
    await d.store(step_only)
    stage_call = await d.current(execution)
    assert stage_call["context_manifest"]["schema_version"] == 1
    assert "budget" not in stage_call["context_manifest"]
    assert_policy(await d.current(execution, SECOND), SMALL_POLICY)


def _many_invalid_layers(pipeline, layers=60):
    stage = pipeline["stages"][0]
    names = [f"call_{index:03d}" for index in range(layers)]
    stage["lifecycle"] = [
        {"name": name, "kind": "llm", "next": names[index + 1] if index + 1 < layers else "finished",
         "params": {"stage": "continue_project", "context_budget": {
             **{f"junk_{key:02d}_" + "x" * 50: 1 for key in range(8)},
             **dict.fromkeys(DEFAULT_POLICY.keys() - {"version"}, "bad"),
         }}}
        for index, name in enumerate(names)
    ] + [{"name": "finished", "kind": "end", "params": {}}]
    pipeline["context_budget"] = {"max_note_body_bytes": "bad"}


async def test_p2_4_write_findings_are_bounded_in_total_with_full_counts(dispatch_case):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    _many_invalid_layers(pipeline)
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text[:300]
    assert len(response.content) <= 8192
    entries = findings(response)
    assert_finding(entries, "context_budget_invalid", "context_budget.max_note_body_bytes")
    omitted = [entry for entry in entries if "omitted_finding_count" in entry.get("params", {})]
    assert len(omitted) == 1 and omitted[0]["params"]["omitted_finding_count"] > 0
    await assert_write_unchanged(d, before)


async def test_p2_5_negotiation_409_findings_respect_the_byte_cap(dispatch_case):
    d = dispatch_case
    await d.store(_many_invalid_layers)
    response = await d.assignment()
    assert response.status_code == 409, response.text[:300]
    assert len(response.content) <= 4096
    context = response.json()["context"]
    assert context["findings_truncated"] is True
    assert context["finding_count"] > len(context["findings"]) > 0
