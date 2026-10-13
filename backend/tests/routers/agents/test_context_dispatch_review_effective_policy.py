# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored companion to the root's policy-projection probe.

Protected required policy is what each invocation of each role actually
requires (inheritance and replacement applied), not explicit arrays at
numeric paths. Renaming the enclosing role is the same bypass as renaming a
step. Controls keep ordinary edits and human operator authority intact."""

import copy

import pytest

from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


def _required_flat(pipeline):
    pipeline["stages"][0]["llm"]["context_sources"][0]["required"] = True


async def test_agent_cannot_move_required_policy_by_renaming_the_role(dispatch_case):
    d = dispatch_case
    await d.store(_required_flat)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["stages"][0]["role"] = "renamed_role_47"
    pipeline.setdefault("scheduling", {})["priority_order"] = ["renamed_role_47"]
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


async def test_human_operator_may_shadow_or_rename_required_policy(dispatch_case):
    d = dispatch_case
    await d.store(lambda p: (two_steps(p), _required_flat(p)))
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["lifecycle"][0]["params"]["context_sources"] = []
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text


async def test_agent_ordinary_edits_beside_required_policy_still_succeed(dispatch_case):
    d = dispatch_case
    await d.store(lambda p: (two_steps(p), _required_flat(p)))
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["llm"]["context_sources"][2]["filter"] = {"kind": "user_note", "limit": 1}
    pipeline["stages"][0]["llm"]["tool_policy"] = {"deny": ["Bash(ordinary-edit:*)"]}
    pipeline["stages"][0]["lifecycle"][1]["params"]["tool_policy"] = {"deny": []}
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 200, response.text


async def test_agent_may_restate_inherited_required_sources_explicitly(dispatch_case):
    # Replacing inheritance with an identical explicit list leaves every
    # invocation's effective requirement unchanged.
    d = dispatch_case
    await d.store(lambda p: (two_steps(p), _required_flat(p)))
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["lifecycle"][0]["params"]["context_sources"] = copy.deepcopy(
        pipeline["stages"][0]["llm"]["context_sources"])
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 200, response.text


async def test_null_pipeline_without_protected_policy_keeps_legacy_reset(dispatch_case):
    d = dispatch_case
    before = await d.config()
    response = await d.case.http.patch(d.config_path, headers=d.headers("agent"), json={
        "pipeline_config": None, "expected_version": before["version"]})
    assert response.status_code == 200, response.text


async def test_null_pipeline_cannot_erase_a_required_source(dispatch_case):
    d = dispatch_case
    await d.store(_required_flat)
    before = await d.config()
    response = await d.case.http.patch(d.config_path, headers=d.headers("recipient"), json={
        "pipeline_config": None, "expected_version": before["version"]})
    assert response.status_code == 422, response.text
    assert "context_dispatch_policy_cannot_be_removed" in finding_codes(response)
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]
