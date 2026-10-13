# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression, ported from the reviewer's budget-identity
probe: budget policy is protected by the identity it applies to (workspace,
stage role, step name, capped source definition), not by JSON array index.

An agent key must not move a stage/step budget to another invocation by
swapping names, retarget or re-assign a source cap, drop inherited caps with
an empty step override, or restructure layers even when today's resolved
limits coincide. Reordering capped sources with their caps, and ordinary
model/tool/end-step/uncapped-source edits, stay allowed."""

import copy

import pytest

from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]
TIGHT = {"max_optional_note_bytes": 1024, "max_managed_context_bytes": 2048, "max_invocation_bytes": 4096}


def lc(p):
    return p["stages"][0]["lifecycle"]


def flat_sources(p):
    return p["stages"][0]["llm"]["context_sources"]


def base(p):
    two_steps(p)
    lc(p)[1]["params"]["context_sources"][0].pop("required")


def step_budget(p):
    base(p)
    lc(p)[1]["params"]["context_budget"] = copy.deepcopy(TIGHT)


def stage_budget_with_twin(p):
    base(p)
    p["stages"][0]["llm"]["context_budget"] = copy.deepcopy(TIGHT)
    twin = copy.deepcopy(p["stages"][0])
    twin["role"] = "other_role_47"
    twin["llm"].pop("context_budget")
    p["stages"].append(twin)


def source_cap(p):
    base(p)
    flat_sources(p)[1]["max_rendered_bytes"] = 64


def workspace_budget(p):
    base(p)
    p["context_budget"] = copy.deepcopy(TIGHT)


def workspace_budget_without_version(p):
    base(p)
    p["context_budget"] = copy.deepcopy(TIGHT)


def invalid_workspace_budget(p):
    base(p)
    p["context_budget"] = "not-a-policy"


def swap_step_names(p):
    lc(p)[0].update(name="second_call", next="first_call")
    lc(p)[1]["name"] = "first_call"


def swap_stage_roles(p):
    role = p["stages"][0]["role"]
    p["stages"][0]["role"], p["stages"][1]["role"] = p["stages"][1]["role"], role


def retarget_capped_source(p):
    flat_sources(p)[1]["filter"] = {"kind": "plan", "limit": 3}


def move_cap_to_other_source(p):
    sources = flat_sources(p)
    cap = sources[1].pop("max_rendered_bytes")
    sources[0], sources[1] = sources[1], sources[0]
    sources[1]["max_rendered_bytes"] = cap


def drop_inherited_caps_with_empty_step_override(p):
    lc(p)[0]["params"]["context_sources"] = []


def move_workspace_budget_onto_stage_layers(p):
    budget = p.pop("context_budget")
    for stage in p["stages"]:
        stage["llm"]["context_budget"] = copy.deepcopy(budget)


def replace_invalid_workspace_budget(p):
    p["context_budget"] = "another-invalid-policy"


def explicit_version_one(p):
    p["context_budget"] = {"version": 1, **TIGHT}


def reorder_capped_sources_with_their_caps(p):
    sources = flat_sources(p)
    sources[0], sources[1] = sources[1], sources[0]


REFUSED = {
    "step_budget_swap_step_names": (step_budget, swap_step_names),
    "stage_budget_swap_stage_roles": (stage_budget_with_twin, swap_stage_roles),
    "source_cap_retarget_subject": (source_cap, retarget_capped_source),
    "source_cap_move_between_sources": (source_cap, move_cap_to_other_source),
    "source_cap_dropped_by_empty_step_override": (source_cap, drop_inherited_caps_with_empty_step_override),
    "workspace_budget_moved_onto_stage_layers": (workspace_budget, move_workspace_budget_onto_stage_layers),
    "invalid_stored_budget_replaced": (invalid_workspace_budget, replace_invalid_workspace_budget),
}
ALLOWED = {
    "step_model": (step_budget, lambda p: lc(p)[1]["params"].update(model="operator-model-48")),
    "step_tool_policy": (step_budget, lambda p: lc(p)[1]["params"].update(tool_policy={"deny": ["Bash(rm:*)"]})),
    "append_end_step": (step_budget, lambda p: lc(p).append({"name": "tail", "kind": "end", "params": {}})),
    "uncapped_source_filter": (source_cap, lambda p: flat_sources(p)[2].update(filter={"kind": "user_note", "limit": 1})),
    "reorder_capped_sources_with_caps": (source_cap, reorder_capped_sources_with_their_caps),
    "omitted_version_restated_as_1": (workspace_budget_without_version, explicit_version_one),
    "invalid_stored_budget_unchanged": (invalid_workspace_budget, lambda p: lc(p)[1]["params"].update(model="m-49")),
}
# B1 composition (root-authorized seam migration): an ordinary edit is still
# never a 403, but a pipeline write must repair a stored invalid budget first.
B1_REFUSED = {"invalid_stored_budget_unchanged": ("context_budget_invalid", "context_budget")}


@pytest.mark.parametrize("name", sorted(REFUSED))
async def test_agent_key_cannot_move_budget_policy_by_identity(dispatch_case, name):
    d = dispatch_case
    setup, mutate = REFUSED[name]
    await d.store(setup)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    mutate(pipeline)
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


@pytest.mark.parametrize("name", sorted(ALLOWED))
async def test_agent_key_ordinary_edits_around_budgets_stay_allowed(dispatch_case, name):
    d = dispatch_case
    setup, mutate = ALLOWED[name]
    await d.store(setup)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    mutate(pipeline)
    response = await d.write(pipeline, actor="agent")
    if name in B1_REFUSED:
        assert response.status_code == 422, response.text
        assert B1_REFUSED[name] in {(f["code"], f["field"]) for f in response.json()["detail"]}
        after = await d.config()
        assert (after["version"], after["pipeline_config"]) == (before["version"], before["pipeline_config"])
        return
    assert response.status_code == 200, response.text
