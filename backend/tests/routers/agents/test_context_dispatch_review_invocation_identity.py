# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regressions for the reviewer's round-2 cases.

What a named invocation of a role requires is protected, wherever the JSON
that produces it lives: swapping stage roles, shadowing with a non-empty
list, a bundle import, or a direct-service null must not let an agent key
run that invocation without its required source. Ordinary agent edits stay
allowed, and the required source is still in the snapshot afterwards."""

import copy
import uuid

import pytest

from app.core.auth import current_agent_id
from app.exceptions import ForbiddenError, ValidationError
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.workspace_config import WorkspaceConfigService
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]
SECOND = {"kind": "lifecycle", "step_name": "second_call", "prompt_slot": "main"}
TWIN = "other_role_47"


def _with_twin(pipeline):
    two_steps(pipeline)
    twin = copy.deepcopy(pipeline["stages"][0])
    twin["role"] = TWIN
    twin["lifecycle"][1]["params"]["context_sources"][0]["required"] = False
    pipeline["stages"].append(twin)


def _flat_required(pipeline):
    two_steps(pipeline)
    pipeline["stages"][0]["llm"]["context_sources"][0]["required"] = True


async def _bound_requiring_second_call(d, setup):
    await d.store(setup)
    _, execution, _ = await d.bound()
    assert (await d.current(execution, SECOND))["dispatch"]["required_source_indices"] == [0]
    return execution


async def test_agent_cannot_swap_stage_roles_away_from_a_required_invocation(dispatch_case):
    d = dispatch_case
    execution = await _bound_requiring_second_call(d, _with_twin)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    first, twin = pipeline["stages"][0], pipeline["stages"][1]
    first["role"], twin["role"] = twin["role"], first["role"]
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text
    assert (await d.current(execution, SECOND))["dispatch"]["required_source_indices"] == [0]


async def test_agent_cannot_shadow_an_inherited_required_source_with_a_nonempty_list(dispatch_case):
    d = dispatch_case
    await d.store(_flat_required)
    _, execution, _ = await d.bound()
    first_call = {**SECOND, "step_name": "first_call"}
    assert (await d.current(execution, first_call))["dispatch"]["required_source_indices"] == [0]
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    optional = copy.deepcopy(pipeline["stages"][0]["llm"]["context_sources"][1])
    pipeline["stages"][0]["lifecycle"][0]["params"]["context_sources"] = [optional]
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("dry_run", [True, False])
async def test_agent_bundle_import_cannot_shadow_required_policy(dispatch_case, dry_run):
    d = dispatch_case
    await d.store(_flat_required)
    before = await d.config()
    exported = await d.case.http.get(d.config_path + "/bundle/export", headers=d.headers("recipient"))
    bundle = exported.json()
    bundle["data"]["pipeline_config"]["stages"][0]["lifecycle"][0]["params"]["context_sources"] = []
    response = await d.case.http.post(d.config_path + "/bundle/import", params={"dry_run": dry_run},
                                      json=bundle, headers=d.headers("agent"))
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


@pytest.mark.parametrize("caller", ["agent_identity", "human_admin", "no_actor"])
async def test_direct_service_null_cannot_erase_required_policy(dispatch_case, caller):
    d = dispatch_case
    await d.store(_flat_required)
    before = await d.config()
    token = current_agent_id.set(uuid.UUID(d.case.agent_id)) if caller == "agent_identity" else None
    expected = ValidationError if caller == "human_admin" else ForbiddenError
    try:
        async with d.case.factory() as db:
            with pytest.raises(expected):
                await WorkspaceConfigService(db).update_config(
                    uuid.UUID(d.case.workspace["id"]), WorkspaceConfigUpdate(pipeline_config=None),
                    actor_id=None if caller == "no_actor" else uuid.UUID(d.case.recipient_id))
            await db.rollback()
    finally:
        if token is not None:
            current_agent_id.reset(token)
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


@pytest.mark.parametrize("edit", ["optional_flat_limit", "required_step_tools_and_model",
                                  "append_end_step", "scheduling_mode"])
async def test_agent_ordinary_edits_keep_required_policy_and_succeed(dispatch_case, edit):
    d = dispatch_case
    execution = await _bound_requiring_second_call(d, _with_twin)
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    stage = pipeline["stages"][0]
    if edit == "optional_flat_limit":
        stage["llm"]["context_sources"][2]["filter"]["limit"] = 1
    elif edit == "required_step_tools_and_model":
        stage["lifecycle"][1]["params"].update(tool_policy={"deny": ["Bash(ordinary:*)"]},
                                               model="operator-model-47")
    elif edit == "append_end_step":
        stage["lifecycle"].append({"name": "spare_end", "kind": "end", "params": {}})
    else:
        pipeline.setdefault("scheduling", {})["mode"] = "round_robin"
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 200, response.text
    assert (await d.current(execution, SECOND))["dispatch"]["required_source_indices"] == [0]
