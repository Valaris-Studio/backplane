# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent A2 policy/negotiation reds against the real config and agent API."""

import copy
import json
import uuid

import pytest
from sqlalchemy import delete, select, update

from app.core.auth import current_agent_id
from app.exceptions import ForbiddenError
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution
from app.models.agents.prompt_config import AgentPromptConfig
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.workspace_config import WorkspaceConfigService
from tests.routers.agents.context_dispatch_support import (
    HEADER,
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def test_legacy_config_control_and_positive_versioned_negotiation(dispatch_case):
    d = dispatch_case
    initial = await d.config()
    write = await d.write(copy.deepcopy(initial["pipeline_config"]))
    assert write.status_code == 200, write.text
    response = await d.contract()
    assert response.status_code == 200, response.text
    assert response.headers.get(HEADER) == "1"
    body = response.json()
    assert body["protocol"] == "context-dispatch" and body["supported_versions"] == [1]
    assert body["agent_id"] == d.case.agent_id and body["workspace_id"] == d.case.workspace["id"]
    assert body["mode"] == "legacy" and body["minimum_version"] == 0
    assert len(body["policy_revision"]) == 64


async def test_owned_enrollment_persists_and_only_raises_targeted_floor(dispatch_case):
    d = dispatch_case
    config = await d.config()
    pipeline = config["pipeline_config"]
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id.upper()]}
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    assert response.json()["pipeline_config"]["context_dispatch"] == {
        "version": 1, "required_agent_ids": [d.case.agent_id],
    }
    required = await d.contract()
    sibling = await d.contract(d.case.other_agent_id, "other_agent")
    assert required.status_code == sibling.status_code == 200
    assert required.json()["mode"] == "required" and required.json()["minimum_version"] == 1
    assert sibling.json()["mode"] == "legacy"
    assert (await d.config())["version"] == config["version"] + 1


@pytest.mark.parametrize("block", [None, {"version": 2, "required_agent_ids": []},
    {"version": True, "required_agent_ids": []}, {"version": 1, "required_agent_ids": ["bad-uuid"]},
    {"version": 1, "required_agent_ids": [], "allow_fallback": True}])
async def test_enrollment_shape_is_strict_and_atomic(dispatch_case, block):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["context_dispatch"] = block
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]
    assert (await d.config())["version"] == before["version"]


async def test_duplicate_enrollment_ids_are_rejected(dispatch_case):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id, d.case.agent_id.upper()]}
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("route", ["patch", "bundle_preview", "bundle_apply"])
async def test_unknown_foreign_and_out_of_scope_enrollment_are_opaque(dispatch_case, route):
    d = dispatch_case
    outcomes = []
    for kind in ["unknown", "foreign_owner", "scope"]:
        agent_id = str(uuid.uuid4()) if kind == "unknown" else d.case.other_agent_id
        if kind != "unknown":
            async with d.case.factory() as db:
                changes = {"created_by_id": uuid.UUID(d.case.recipient_id), "allowed_workspaces": [d.case.workspace["slug"]]}
                if kind == "foreign_owner":
                    from app.models.workspace import Workspace
                    workspace = await db.get(Workspace, uuid.UUID(d.case.workspace["id"]))
                    changes["created_by_id"] = workspace.created_by
                else:
                    changes["allowed_workspaces"] = ["unrelated-workspace"]
                await db.execute(update(Agent).where(Agent.id == uuid.UUID(agent_id)).values(**changes))
                await db.commit()
        pipeline = (await d.config())["pipeline_config"]
        pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [agent_id]}
        if route == "patch":
            response = await d.write(pipeline)
        else:
            exported = await d.case.http.get(d.config_path + "/bundle/export", headers=d.headers("recipient"))
            assert exported.status_code == 200, exported.text
            bundle = exported.json()
            bundle["data"]["pipeline_config"] = pipeline
            response = await d.case.http.post(d.config_path + "/bundle/import",
                params={"dry_run": route == "bundle_preview"}, json=bundle, headers=d.headers("recipient"))
        if route == "bundle_preview":
            assert response.status_code == 200, response.text
            errors = response.json()["validation"]["pipeline_errors"]
        else:
            assert response.status_code == 422, response.text
            errors = response.json()["detail"]
        unavailable = [e for e in errors if e.get("code") == "context_dispatch_agent_unavailable"]
        assert len(unavailable) == 1, errors
        # The caller supplied the UUID, but learns no existence/owner/scope distinction.
        outcomes.append(json.dumps(unavailable[0], sort_keys=True).replace(agent_id, "<submitted-id>"))
    assert outcomes[0] == outcomes[1] == outcomes[2]
    assert "context_dispatch" not in (await d.config())["pipeline_config"]


@pytest.mark.parametrize("mutation", ["remove", "empty", "nested_required_remove"])
async def test_agent_key_cannot_weaken_protected_policy_in_full_replacement(dispatch_case, mutation):
    d = dispatch_case
    await d.enroll()
    if mutation == "nested_required_remove":
        await d.store(two_steps)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    if mutation == "remove":
        pipeline.pop("context_dispatch")
    elif mutation == "empty":
        pipeline["context_dispatch"]["required_agent_ids"] = []
    else:
        pipeline["stages"][0]["lifecycle"][1]["params"]["context_sources"][0]["required"] = False
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


async def test_operator_omission_is_not_disable_but_explicit_empty_is(dispatch_case):
    d = dispatch_case
    await d.enroll()
    pipeline = (await d.config())["pipeline_config"]
    omitted = copy.deepcopy(pipeline)
    omitted.pop("context_dispatch")
    response = await d.write(omitted)
    assert response.status_code == 422, response.text
    assert "context_dispatch_removal_requires_explicit_empty" in finding_codes(response)
    pipeline["context_dispatch"]["required_agent_ids"] = []
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    assert (await d.contract()).json()["mode"] == "legacy"


async def test_direct_service_agent_guard_cannot_be_bypassed(dispatch_case):
    d = dispatch_case
    await d.enroll()
    pipeline = (await d.config())["pipeline_config"]
    pipeline["context_dispatch"]["required_agent_ids"] = []
    token = current_agent_id.set(uuid.UUID(d.case.agent_id))
    try:
        async with d.case.factory() as db:
            with pytest.raises(ForbiddenError):
                await WorkspaceConfigService(db).update_config(uuid.UUID(d.case.workspace["id"]),
                    WorkspaceConfigUpdate(pipeline_config=pipeline), actor_id=uuid.UUID(d.case.recipient_id))
            await db.rollback()
    finally:
        current_agent_id.reset(token)


@pytest.mark.parametrize("dry_run", [True, False])
async def test_agent_bundle_cannot_remove_policy_even_in_preview(dispatch_case, dry_run):
    d = dispatch_case
    await d.enroll()
    exported = await d.case.http.get(d.config_path + "/bundle/export", headers=d.headers("recipient"))
    assert exported.status_code == 200, exported.text
    bundle = exported.json()
    bundle["data"]["pipeline_config"]["context_dispatch"]["required_agent_ids"] = []
    response = await d.case.http.post(d.config_path + "/bundle/import", params={"dry_run": dry_run},
                                    json=bundle, headers=d.headers("agent"))
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"]["context_dispatch"]["required_agent_ids"] == [d.case.agent_id]


async def test_inactive_owned_agent_can_enroll_but_cannot_dispatch(dispatch_case):
    d = dispatch_case
    async with d.case.factory() as db:
        await db.execute(update(Agent).where(Agent.id == uuid.UUID(d.case.agent_id)).values(is_active=False))
        await db.commit()
    pipeline = (await d.config())["pipeline_config"]
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    # A plain owner key authenticates independently of the inactive agent key.
    response = await d.case.http.post(d.agent_path() + "/next-assignment",
                                     json={"context_dispatch_version": 1}, headers=d.headers("recipient"))
    assert response.status_code == 403, response.text


async def test_unchanged_deleted_enrollment_does_not_poison_unrelated_config_write(dispatch_case):
    d = dispatch_case
    await d.store(lambda p: p.update(context_dispatch={"version": 1, "required_agent_ids": [d.case.other_agent_id]}))
    async with d.case.factory() as db:
        await db.execute(delete(Agent).where(Agent.id == uuid.UUID(d.case.other_agent_id)))
        await db.commit()
    pipeline = (await d.config())["pipeline_config"]
    pipeline["lock_roles"] = True
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    assert response.json()["pipeline_config"]["context_dispatch"]["required_agent_ids"] == [d.case.other_agent_id]


@pytest.mark.parametrize("place", ["flat", "second_step"])
async def test_any_required_source_raises_floor_for_whole_workspace(dispatch_case, place):
    d = dispatch_case
    if place == "flat":
        await d.store(lambda p: p["stages"][0]["llm"]["context_sources"][0].update(required=True))
    else:
        await d.store(two_steps)
    for agent_id, actor in [(d.case.agent_id, "agent"), (d.case.other_agent_id, "other_agent")]:
        response = await d.contract(agent_id, actor)
        assert response.status_code == 200, response.text
        assert response.json()["mode"] == "required" and response.json()["minimum_version"] == 1


@pytest.mark.parametrize("required", ["true", 1, None])
async def test_source_required_is_strict_boolean_on_nonfirst_step(dispatch_case, required):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    two_steps(pipeline)
    pipeline["stages"][0]["lifecycle"][1]["params"]["context_sources"][0]["required"] = required
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text


@pytest.mark.parametrize("place", ["workspace", "stage", "second_step", "source_cap"])
async def test_budget_write_is_enforced_and_unresolvable_persisted_budget_blocks_assignment_and_start(
    dispatch_case, place,
):
    # Milestone migration authorized by root once B1 enforcement is composed;
    # replaces the pre-B1 "budgets unavailable" gate (original evidence archived).
    d = dispatch_case

    def opt_in(p, *, valid=True):
        budget = {"version": 1, "max_invocation_bytes": 262144 if valid else True}
        if place == "workspace":
            p["context_budget"] = budget
        elif place == "stage":
            p["stages"][0]["llm"]["context_budget"] = budget
        elif place == "source_cap":
            p["stages"][0]["llm"]["context_sources"][0]["max_rendered_bytes"] = 1024 if valid else "1024"
        else:
            if "lifecycle" not in p["stages"][0]:
                two_steps(p)
            p["stages"][0]["lifecycle"][1]["params"]["context_budget"] = budget

    pipeline = (await d.config())["pipeline_config"]
    opt_in(pipeline)
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    contract = await d.contract()
    assert contract.status_code == 200 and contract.json()["minimum_version"] == 1
    # A valid, current negotiated hold, so neither a missing version nor a
    # missing hold can be what refuses the start below.
    held = await d.assignment()
    assert held.status_code == 200, held.text
    assignment = held.json()
    revision = assignment["context_dispatch"]["policy_revision"]

    await d.store(lambda p: opt_in(p, valid=False))
    assert (await d.config())["pipeline_config"]  # remains readable
    started = await d.case.http.post(
        f"/api/agents/{d.case.agent_id}/executions",
        json=d.case.start_payload(assignment, context_dispatch_version=1,
                                  context_dispatch_policy_revision=revision),
        headers=d.headers(),
    )
    for response in [await d.assignment(), started]:
        assert response.status_code == 409, response.text
        assert "context_budget_invalid" in finding_codes(response)
    async with d.case.factory() as db:
        executions = (await db.execute(select(AgentExecution).where(
            AgentExecution.agent_id == uuid.UUID(d.case.agent_id),
        ))).scalars().all()
    assert executions == []


async def test_required_assignment_and_start_refuse_missing_version(dispatch_case):
    d = dispatch_case
    assignment = await d.case.assignment()
    await d.enroll()
    denied = await d.assignment(version=None)
    assert denied.status_code == 409, denied.text
    assert "context_dispatch_version_required" in finding_codes(denied)
    denied = await d.case.http.post(f"/api/agents/{d.case.agent_id}/executions",
                                    json=d.case.start_payload(assignment), headers=d.headers(version=None))
    assert denied.status_code == 409, denied.text


async def test_floor_raise_refuses_active_legacy_execution_and_stale_config_write(dispatch_case):
    d = dispatch_case
    assignment = await d.case.assignment()
    await d.case.start(assignment)
    config = await d.config()
    pipeline = copy.deepcopy(config["pipeline_config"])
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    response = await d.write(pipeline)
    assert response.status_code == 409, response.text
    assert "context_dispatch_legacy_execution_active" in finding_codes(response)
    response = await d.write(config["pipeline_config"], expected_version=config["version"] - 1)
    assert response.status_code == 409, response.text


async def test_required_binding_does_not_downgrade_after_cohort_removal(dispatch_case):
    d = dispatch_case
    _, execution, start_payload = await d.bound()
    stamp = execution["context_binding"].get("context_dispatch")
    assert stamp is not None, "Bound execution must retain its negotiated floor"
    assert stamp["version"] == 1 and stamp["mode"] == "required"
    pipeline = (await d.config())["pipeline_config"]
    pipeline["context_dispatch"]["required_agent_ids"] = []
    assert (await d.write(pipeline)).status_code == 200
    assert (await d.contract()).json()["mode"] == "legacy"
    current = await d.current(execution)
    assert current["mode"] == "required" and current["context_binding"]["context_dispatch"] == stamp
    replay = await d.case.http.post(f"/api/agents/{d.case.agent_id}/executions",
                                    json=start_payload, headers=d.headers())
    assert replay.status_code == 200 and replay.json()["context_binding"]["context_dispatch"] == stamp


@pytest.mark.parametrize("missing", ["mapping", "target"])
async def test_required_opt_in_preflights_applicable_auxiliary_prompt_without_mutating_legacy(dispatch_case, missing):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    llm = pipeline["stages"][0]["llm"]
    llm.update(approval_enabled=True, stage="implement", post_process_kind="writes_code")
    # Today's independent validation only wires approval for this stage name.
    async with d.case.factory() as db:
        await db.execute(update(AgentPromptConfig).where(AgentPromptConfig.id == d.template_id).values(stage="implement"))
        await db.commit()
    # An old optional pipeline stays readable; activation must identify its
    # real post-approval call slot before any required-mode execution is offered.
    legacy_write = await d.write(pipeline)
    assert legacy_write.status_code == 200, legacy_write.text
    legacy = await d.config()
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    if missing == "target":
        llm["prompt_slots"] = {"implement_after_approval": {
            "role": "missing_operator_role_88", "stage": "missing_operator_stage_88",
        }}
    denied = await d.write(pipeline)
    assert denied.status_code == 422, denied.text
    assert "context_dispatch_prompt_unavailable" in finding_codes(denied)
    assert (await d.config())["pipeline_config"] == legacy["pipeline_config"]
    llm["prompt_slots"] = {"implement_after_approval": {
        "role": pipeline["stages"][0]["role"], "stage": llm["stage"],
    }}
    accepted = await d.write(pipeline)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["pipeline_config"]["stages"][0]["llm"]["prompt_slots"] == llm["prompt_slots"]


async def test_policy_revision_is_rechecked_between_negotiation_assignment_and_start(dispatch_case):
    d = dispatch_case
    contract = await d.contract()
    assert contract.status_code == 200, contract.text
    old_revision = contract.json()["policy_revision"]
    await d.enroll()
    body = {"board_id": d.case.board_id, "context_dispatch_version": 1,
            "context_dispatch_policy_revision": old_revision}
    stale_assignment = await d.case.http.post(d.agent_path() + "/next-assignment",
                                               json=body, headers=d.headers())
    assert stale_assignment.status_code == 409, stale_assignment.text
    assert "context_dispatch_policy_changed" in finding_codes(stale_assignment)
    fresh_assignment = await d.assignment()
    assert fresh_assignment.status_code == 200, fresh_assignment.text
    assignment = fresh_assignment.json()
    before = assignment["context_dispatch"]["policy_revision"]
    await d.store(lambda p: p["context_dispatch"]["required_agent_ids"].append(d.case.other_agent_id))
    stale_start = await d.case.http.post(f"/api/agents/{d.case.agent_id}/executions",
        json=d.case.start_payload(assignment, context_dispatch_version=1,
                                  context_dispatch_policy_revision=before), headers=d.headers())
    assert stale_start.status_code == 409, stale_start.text
    assert "context_dispatch_policy_changed" in finding_codes(stale_start)


async def test_direct_service_context_policy_requires_current_human_operator_membership(dispatch_case):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    pipeline["context_dispatch"] = {"version": 1, "required_agent_ids": [d.case.agent_id]}
    async with d.case.factory() as db:
        await db.execute(update(WorkspaceMember).where(
            WorkspaceMember.workspace_id == uuid.UUID(d.case.workspace["id"]),
            WorkspaceMember.user_id == uuid.UUID(d.case.recipient_id),
        ).values(role=WorkspaceRole.member))
        await db.commit()
    async with d.case.factory() as db:
        with pytest.raises(ForbiddenError):
            await WorkspaceConfigService(db).update_config(uuid.UUID(d.case.workspace["id"]),
                WorkspaceConfigUpdate(pipeline_config=pipeline), actor_id=uuid.UUID(d.case.recipient_id))
        await db.rollback()
    assert "context_dispatch" not in (await d.config())["pipeline_config"]
