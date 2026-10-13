# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression for the reviewer's adjacent budget-identity
cases (ported from probe_budget_identity_r2.py).

A step is its own budget identity only where it diverges from what it
inherits (its own budget layer, or effective caps that differ from the
flat stage's). Renaming a step that merely inherits capped flat sources is
therefore an ordinary edit, while overriding them away is not. Per the
root's budget contract, {} and {version: 1} opt in to the same inherited
defaults (an omitted version is 1). Malformed llm step params (null,
non-dict) are opaque protected values of a real step, never confused with
the flat stage block, and never a 500; missing params read as {}."""

import copy
import uuid

import pytest

from app.core.auth import current_agent_id
from app.exceptions import ForbiddenError
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.workspace_config import WorkspaceConfigService
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]
TIGHT = {"max_optional_note_bytes": 1024, "max_managed_context_bytes": 2048, "max_invocation_bytes": 4096}


def lc(p):
    return p["stages"][0]["lifecycle"]


def flat(p):
    return p["stages"][0]["llm"]["context_sources"]


def base(p):
    two_steps(p)
    lc(p)[1]["params"]["context_sources"][0].pop("required")


def capped(p):
    base(p)
    flat(p)[1]["max_rendered_bytes"] = 64


def twin_capped(p):
    capped(p)
    flat(p).append(copy.deepcopy(flat(p)[1]))


def stored_version_only(p):
    base(p)
    p["stages"][0]["llm"]["context_budget"] = {"version": 1}


def stored_invalid(p):
    base(p)
    p["stages"][0]["llm"]["context_budget"] = "garbage"


def step_budget(p):
    base(p)
    lc(p)[1]["params"]["context_budget"] = copy.deepcopy(TIGHT)


def with_paramless_step(shape):
    def setup(p):
        step_budget(p)
        step = {"name": "bare_call", "kind": "llm", "next": "finished"}
        if shape == "non_dict_params":
            step["params"] = "nope"
        elif shape == "null_params":
            step["params"] = None
        lc(p).insert(2, step)
        lc(p)[1]["next"] = "bare_call"
    return setup


LAYERS = {
    "workspace": lambda p: p,
    "stage": lambda p: p["stages"][0]["llm"],
    "step": lambda p: lc(p)[1]["params"],
}


def add_empty_budget(layer):
    # Absent must never read as {}: an empty object is an opt-in.
    return lambda p: LAYERS[layer](p).update(context_budget={})


def stored_empty_budget(layer):
    def setup(p):
        base(p)
        LAYERS[layer](p)["context_budget"] = {}
    return setup


def remove_budget(layer):
    return lambda p: LAYERS[layer](p).pop("context_budget")


def swap_step_names(p):
    lc(p)[0].update(name="second_call", next="first_call")
    lc(p)[1]["name"] = "first_call"


def uncapped_copies_of_inherited(p):
    lc(p)[0]["params"]["context_sources"] = [
        {k: v for k, v in s.items() if k != "max_rendered_bytes"} for s in flat(p)]


def model_edit(p):
    p["stages"][0]["llm"]["model"] = "operator-model-48"


AGENT = {
    "inherited_caps_replaced_by_uncapped_copies": (capped, uncapped_copies_of_inherited, 403),
    "one_of_two_identical_capped_sources_dropped": (twin_capped, lambda p: flat(p).pop(3), 403),
    "stored_invalid_budget_removed": (stored_invalid, lambda p: p["stages"][0]["llm"].pop("context_budget"), 403),
    # Root decision: an omitted version defaults to 1 on an empty object too.
    "version_only_budget_rewritten_as_empty": (
        stored_version_only, lambda p: p["stages"][0]["llm"].update(context_budget={}), 200),
    "rename_step_that_only_inherits_caps": (capped, lambda p: lc(p)[0].update(name="first_call_renamed"), 200),
    "capped_model_edit": (capped, model_edit, 200),
    # B1 composition (root-authorized seam migration): every pipeline write
    # must repair a stored invalid effective budget first; still not a 403.
    "stored_invalid_budget_unrelated_edit": (stored_invalid, model_edit, 422),
    "missing_params_unrelated_edit": (with_paramless_step("missing_params"), model_edit, 200),
    # The existing structural validator already refuses re-saving malformed
    # params (422 lifecycle_step_invalid_params): refused, never a 500.
    "non_dict_params_unrelated_edit": (with_paramless_step("non_dict_params"), model_edit, 422),
    "non_dict_params_replaced": (
        with_paramless_step("non_dict_params"), lambda p: lc(p)[2].update(params={}), 403),
    # A named step stored with params: null is still that step, not the flat
    # block: its stored value is protected, and unrelated edits pass.
    "null_params_replaced": (
        with_paramless_step("null_params"), lambda p: lc(p)[2].update(params={}), 403),
    "null_params_unrelated_edit": (with_paramless_step("null_params"), model_edit, 200),
    **{f"empty_budget_added_to_{layer}": (base, add_empty_budget(layer), 403) for layer in LAYERS},
    **{f"empty_budget_removed_from_{layer}": (stored_empty_budget(layer), remove_budget(layer), 403)
       for layer in LAYERS},
}


# Bounded B1 finding each migrated 422 must carry (code, field).
B1_FINDINGS = {"stored_invalid_budget_unrelated_edit": ("context_budget_invalid", "stages[0].llm.context_budget")}


@pytest.mark.parametrize("name", sorted(AGENT))
async def test_agent_budget_identity_adjacent(dispatch_case, name):
    d = dispatch_case
    setup, mutate, expected = AGENT[name]
    await d.store(setup)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    mutate(pipeline)
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == expected, response.text
    if expected != 200:
        assert (await d.config())["pipeline_config"] == before["pipeline_config"]
    if name in B1_FINDINGS:
        assert B1_FINDINGS[name] in {(f["code"], f["field"]) for f in response.json()["detail"]}
        assert (await d.config())["version"] == before["version"]


@pytest.mark.parametrize("route", ["bundle_preview", "bundle_apply", "service_agent"])
async def test_step_budget_swap_is_refused_on_every_agent_route(dispatch_case, route):
    d = dispatch_case
    await d.store(step_budget)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    swap_step_names(pipeline)
    if route.startswith("bundle"):
        bundle = (await d.case.http.get(d.config_path + "/bundle/export", headers=d.headers("recipient"))).json()
        bundle["data"]["pipeline_config"] = pipeline
        response = await d.case.http.post(d.config_path + "/bundle/import",
                                          params={"dry_run": route == "bundle_preview"},
                                          json=bundle, headers=d.headers("agent"))
        assert response.status_code == 403, response.text
    else:
        token = current_agent_id.set(uuid.UUID(d.case.agent_id))
        try:
            async with d.case.factory() as db:
                with pytest.raises(ForbiddenError):
                    await WorkspaceConfigService(db).update_config(
                        uuid.UUID(d.case.workspace["id"]),
                        WorkspaceConfigUpdate(pipeline_config=pipeline, expected_version=before["version"]),
                        actor_id=uuid.UUID(d.case.recipient_id))
                await db.rollback()
        finally:
            current_agent_id.reset(token)
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


async def test_human_admin_may_swap_budgeted_step_names(dispatch_case):
    d = dispatch_case
    await d.store(step_budget)
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    swap_step_names(pipeline)
    response = await d.write(pipeline)
    # A human admin may move a valid budget to another identity: with B1
    # enforcement composed it is validated and accepted, never a 403 or 500.
    assert response.status_code == 200, response.text
