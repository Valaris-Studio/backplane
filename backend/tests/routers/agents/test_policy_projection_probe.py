# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent review probes, applied only to a disposable exact-source export."""

import copy
import json
import pytest
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


@pytest.mark.parametrize("actor,expected", [("agent", 403), ("recipient", 422)])
async def test_null_pipeline_cannot_erase_enrollment(
    dispatch_case, actor, expected, record_property
):
    d = dispatch_case
    await d.enroll()
    before = await d.config()
    response = await d.case.http.patch(
        d.config_path,
        headers=d.headers(actor),
        json={"pipeline_config": None, "expected_version": before["version"]},
    )
    after = await d.config()
    observed = {
        "actor": actor,
        "status": response.status_code,
        "pipeline_after": after["pipeline_config"],
        "contract_after": (await d.contract()).json()["mode"],
    }
    record_property("observation", json.dumps(observed, ensure_ascii=False))
    assert response.status_code == expected, observed
    assert after["pipeline_config"] == before["pipeline_config"]


@pytest.mark.parametrize("change", ["shadow_inherited", "rename_steps"])
async def test_agent_cannot_remove_effective_required_source_without_changing_explicit_source(
    dispatch_case, change, record_property
):
    d = dispatch_case

    def setup(p):
        two_steps(p)
        if change == "shadow_inherited":
            p["stages"][0]["llm"]["context_sources"][0]["required"] = True

    await d.store(setup)
    _, execution, _ = await d.bound()
    step = "first_call" if change == "shadow_inherited" else "second_call"
    invocation = {"kind": "lifecycle", "step_name": step, "prompt_slot": "main"}
    before = await d.current(execution, invocation)
    assert before["dispatch"]["required_source_indices"]
    pipeline = copy.deepcopy((await d.config())["pipeline_config"])
    if change == "shadow_inherited":
        pipeline["stages"][0]["lifecycle"][0]["params"]["context_sources"] = []
    else:
        pipeline["stages"][0]["lifecycle"][0].update(
            name="second_call", next="first_call"
        )
        pipeline["stages"][0]["lifecycle"][1]["name"] = "first_call"
    response = await d.write(pipeline, actor="agent")
    observed = {
        "change": change,
        "write_status": response.status_code,
        "before_required": before["dispatch"]["required_source_indices"],
    }
    if response.status_code == 200:
        after = await d.current(execution, invocation)
        prepared = await d.prepare(
            execution,
            d.payload(
                after,
                input_prompt="No required source included in this synthetic probe.",
            ),
        )
        observed.update(
            after_required=after["dispatch"]["required_source_indices"],
            preparation_status=prepared.status_code,
        )
    record_property("observation", json.dumps(observed))
    assert response.status_code == 403, observed
