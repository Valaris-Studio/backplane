# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B1 activation, strict inherited ceilings and actual named-step policies."""

import copy
import uuid

import pytest

from app.exceptions import ValidationError
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.workspace_config import WorkspaceConfigService
from tests.routers.agents.context_budget_policy_support import (
    SECOND,
    SMALL_POLICY,
    assert_finding,
    assert_policy,
    assert_write_unchanged,
    findings,
    install_instance,
    install_policy,
)
from tests.routers.agents.context_budgets_support import DEFAULT_POLICY
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
    two_steps,
)
from tests.routers.agents.context_receipts_support import ALIAS

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


@pytest.mark.parametrize("place", ["workspace", "stage", "second_step", "source_cap"])
async def test_enforced_budget_activation_accepts_write_and_negotiates_bound_schema2(dispatch_case, place):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    if place == "source_cap":
        pipeline["stages"][0]["llm"]["context_sources"][0]["max_rendered_bytes"] = 8192
    else:
        install_policy(pipeline, place, {})
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    after = await d.config()
    assert after["version"] == before["version"] + 1
    contract = await d.contract()
    assert contract.status_code == 200, contract.text
    assert contract.json()["minimum_version"] == 1
    _, execution, _ = await d.bound(required=False)
    snapshot = await d.current(execution, SECOND if place == "second_step" else None)
    assert_policy(snapshot, DEFAULT_POLICY)


INVALID_BLOCKS = [
    (None, ""), ([], ""), ({"unknown_limit": 3}, ".unknown_limit"),
    ({"version": True}, ".version"), ({"version": "1"}, ".version"), ({"version": 1.0}, ".version"),
    ({"version": 2}, ".version"), ({"version": None}, ".version"),
    ({"max_note_body_bytes": True}, ".max_note_body_bytes"),
    ({"max_note_body_bytes": 1024.0}, ".max_note_body_bytes"),
    ({"max_note_fetch_bytes": "2097152"}, ".max_note_fetch_bytes"),
    ({"max_optional_note_bytes": 1.5}, ".max_optional_note_bytes"),
    ({"max_managed_context_bytes": 0}, ".max_managed_context_bytes"),
    ({"max_invocation_bytes": -1}, ".max_invocation_bytes"),
]


@pytest.mark.parametrize("place", ["workspace", "stage", "second_step"])
@pytest.mark.parametrize(("invalid", "suffix"), INVALID_BLOCKS)
async def test_policy_invalid_write_reports_exact_location_and_is_atomic(dispatch_case, place, invalid, suffix):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    path = install_policy(pipeline, place, invalid)
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    assert_finding(findings(response), "context_budget_invalid", path + suffix)
    await assert_write_unchanged(d, before)


@pytest.mark.parametrize("place", ["workspace", "stage", "second_step"])
async def test_override_cannot_raise_parent_ceiling_even_below_instance_maximum(dispatch_case, place):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    if place == "workspace":
        limit = DEFAULT_POLICY["max_note_body_bytes"]
    else:
        pipeline["context_budget"] = dict(SMALL_POLICY)
        limit = SMALL_POLICY["max_note_body_bytes"]
        if place == "second_step":
            pipeline["stages"][0]["llm"]["context_budget"] = {"max_note_body_bytes": limit // 2}
            limit //= 2
    path = install_policy(pipeline, place, {"max_note_body_bytes": limit + 1})
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    entry = assert_finding(findings(response), "context_budget_ceiling_exceeded", path + ".max_note_body_bytes")
    assert entry["params"]["limit"] == limit and entry["params"]["effective_value"] == limit + 1
    await assert_write_unchanged(d, before)


@pytest.mark.parametrize(("changes", "pair"), [
    ({"max_note_fetch_bytes": 64}, {"max_note_body_bytes", "max_note_fetch_bytes"}),
    ({"max_managed_context_bytes": 64}, {"max_optional_note_bytes", "max_managed_context_bytes"}),
    ({"max_invocation_bytes": 64}, {"max_managed_context_bytes", "max_invocation_bytes"}),
])
async def test_effective_relations_are_checked_after_inheritance(dispatch_case, changes, pair):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    install_policy(pipeline, "stage", changes)
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    entries = [f for f in findings(response) if f.get("code") == "context_budget_inconsistent"]
    assert entries and any(pair <= {v for v in f["params"].values() if isinstance(v, str)} for f in entries), entries
    await assert_write_unchanged(d, before)


async def test_direct_service_rejects_invalid_policy_and_leaves_rollback_to_caller(dispatch_case, monkeypatch):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["context_budget"] = {"max_note_body_bytes": True}
    async with d.case.factory() as db:
        async def forbidden_commit():
            pytest.fail("Config service must leave commit to its caller")
        monkeypatch.setattr(db, "commit", forbidden_commit)
        with pytest.raises(ValidationError) as raised:
            await WorkspaceConfigService(db).update_config(
                uuid.UUID(d.case.workspace["id"]),
                WorkspaceConfigUpdate(pipeline_config=pipeline, expected_version=before["version"]),
                actor_id=uuid.UUID(d.case.recipient_id),
            )
        assert_finding(raised.value.detail, "context_budget_invalid", "context_budget.max_note_body_bytes")
        await db.rollback()
    await assert_write_unchanged(d, before)


async def test_valid_direct_service_change_is_rolled_back_by_owning_transaction(dispatch_case, monkeypatch):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["context_budget"] = dict(SMALL_POLICY)
    async with d.case.factory() as db:
        async def forbidden_commit():
            pytest.fail("Config service must leave commit to its caller")
        monkeypatch.setattr(db, "commit", forbidden_commit)
        await WorkspaceConfigService(db).update_config(
            uuid.UUID(d.case.workspace["id"]),
            WorkspaceConfigUpdate(pipeline_config=pipeline, expected_version=before["version"]),
            actor_id=uuid.UUID(d.case.recipient_id),
        )
        await db.rollback()
    await assert_write_unchanged(d, before)


@pytest.mark.parametrize("repair", ["absent", "stage", "workspace"])
async def test_lower_instance_cap_requires_valid_workspace_ancestor(dispatch_case, monkeypatch, repair):
    d = dispatch_case
    install_instance(monkeypatch, max_note_body_bytes=512)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["context_budget"] = {}
    if repair != "absent":
        install_policy(pipeline, repair, {"max_note_body_bytes": 512})
    response = await d.write(pipeline)
    if repair == "workspace":
        assert response.status_code == 200, response.text
        _, execution, _ = await d.bound(required=False)
        assert_policy(await d.current(execution), {**DEFAULT_POLICY, "max_note_body_bytes": 512})
    else:
        assert response.status_code == 422, response.text
        assert_finding(findings(response), "context_budget_ceiling_exceeded", "context_budget.max_note_body_bytes")
        await assert_write_unchanged(d, before)


async def test_increased_instance_ceiling_does_not_raise_workspace_defaults(dispatch_case, monkeypatch):
    d = dispatch_case
    install_instance(monkeypatch, **{key: value * 2 for key, value in DEFAULT_POLICY.items() if key != "version"})
    _, execution, _ = await d.bound()
    await d.store(lambda p: p.update(context_budget={}))
    assert_policy(await d.current(execution), DEFAULT_POLICY)


async def test_explicit_workspace_policy_can_use_raised_instance_capacity(dispatch_case, monkeypatch):
    d = dispatch_case
    raised = {**DEFAULT_POLICY, "max_note_body_bytes": 2097152, "max_note_fetch_bytes": 4194304}
    install_instance(monkeypatch, **raised)
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    pipeline["context_budget"] = raised
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text
    _, execution, _ = await d.bound(required=False)
    assert_policy(await d.current(execution), raised)


@pytest.mark.parametrize("source_mode", ["inherit", "replace", "empty"])
async def test_second_named_step_resolves_its_sources_and_each_inherited_budget_field(dispatch_case, source_mode):
    d = dispatch_case

    def configure(p):
        p["context_budget"] = dict(SMALL_POLICY)
        p["stages"][0]["llm"]["context_budget"] = {"max_note_body_bytes": 32768, "max_invocation_bytes": 24576}
        two_steps(p)
        steps = p["stages"][0]["lifecycle"]
        steps[0]["params"].update(context_sources=[], context_budget={"max_note_body_bytes": 1})
        steps[1]["params"]["context_budget"] = {"max_note_fetch_bytes": 65536, "max_optional_note_bytes": 4096}
        if source_mode == "inherit":
            steps[1]["params"].pop("context_sources")
        elif source_mode == "empty":
            steps[1]["params"]["context_sources"] = []

    # Bind before the direct seed to isolate resolver behavior from activation.
    _, execution, _ = await d.bound()
    await d.store(configure)
    snapshot = await d.current(execution, SECOND)
    assert snapshot["invocation"] == SECOND
    assert_policy(snapshot, {**SMALL_POLICY, "max_note_body_bytes": 32768, "max_note_fetch_bytes": 65536,
                             "max_optional_note_bytes": 4096, "max_invocation_bytes": 24576})
    expected = {"inherit": {ALIAS, "KindOnly", "RepeatedAlias47"}, "replace": {"SecondContext47"}, "empty": set()}
    assert set(snapshot["context"]) == expected[source_mode]
    if source_mode != "empty":
        assert all(snapshot["context"].values())
    else:
        assert snapshot["context_manifest"]["sources"] == []


async def test_invalid_persisted_policy_refuses_context_without_legacy_fallback(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    await d.store(lambda p: p.update(context_budget={"max_invocation_bytes": True}))
    response = await d.snapshot(execution)
    assert response.status_code == 409, response.text
    assert "context_budget_invalid" in finding_codes(response)
    assert_finding(findings(response), "context_budget_invalid", "context_budget.max_invocation_bytes")
    assert "context_manifest" not in response.json() and ALIAS not in response.text


async def test_legacy_config_write_and_a1_context_remain_available_without_opt_in(dispatch_case):
    d = dispatch_case
    before = await d.config()
    response = await d.write(copy.deepcopy(before["pipeline_config"]))
    assert response.status_code == 200, response.text
    assignment = await d.case.assignment()
    execution = await d.case.start(assignment)
    response = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context", headers=d.headers())
    assert response.status_code == 200, response.text
    assert response.json()["context_manifest"]["schema_version"] == 1
    assert "budget" not in response.json()["context_manifest"]
