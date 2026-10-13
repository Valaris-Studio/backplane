# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Policy tests exercise existing HTTP and service entry points, not a resolver API."""

import copy

from app.config import Settings, settings
from tests.routers.agents.context_budgets_support import DEFAULT_POLICY, policy_digest
from tests.routers.agents.context_dispatch_support import two_steps

SMALL_POLICY = {
    "version": 1,
    "max_note_body_bytes": 65536,
    "max_note_fetch_bytes": 131072,
    "max_optional_note_bytes": 8192,
    "max_managed_context_bytes": 16384,
    "max_invocation_bytes": 32768,
}
SECOND = {"kind": "lifecycle", "step_name": "second_call", "prompt_slot": "main"}


def install_policy(pipeline, place, policy):
    if place == "workspace":
        target, path = pipeline, "context_budget"
    elif place == "stage":
        target, path = pipeline["stages"][0]["llm"], "stages[0].llm.context_budget"
    else:
        if "lifecycle" not in pipeline["stages"][0] or not any(
            step["name"] == "second_call" for step in pipeline["stages"][0]["lifecycle"]
        ):
            two_steps(pipeline)
        target = pipeline["stages"][0]["lifecycle"][1]["params"]
        path = "stages[0].lifecycle[1].params.context_budget"
    target["context_budget"] = copy.deepcopy(policy)
    return path


def install_instance(monkeypatch, **changes):
    values = {**DEFAULT_POLICY, **changes}
    if "CONTEXT_BUDGET_CEILINGS" in Settings.model_fields:
        configured = Settings(_env_file=None, CONTEXT_BUDGET_CEILINGS=values)
        value = configured.CONTEXT_BUDGET_CEILINGS
    else:
        # A1 has no typed setting. Seed valid future configuration so its missing
        # policy enforcement is a behavioral red, not an AttributeError.
        value = values
    monkeypatch.setitem(settings.__dict__, "CONTEXT_BUDGET_CEILINGS", value)


def assert_policy(snapshot, expected):
    manifest = snapshot["context_manifest"]
    assert manifest["schema_version"] == 2
    assert manifest["budget"]["policy"] == expected
    assert manifest["budget"]["policy_sha256"] == policy_digest(expected)


def findings(response):
    body = response.json()
    result = body.get("detail")
    if not isinstance(result, list):
        result = body.get("context", {}).get("findings")
    assert isinstance(result, list) and result, response.text
    return result


def assert_finding(entries, code, path):
    matches = [f for f in entries if f.get("code") == code and f.get("field") == path]
    assert matches, entries
    assert all(f["severity"] == "error" and isinstance(f["message"], str) for f in matches)
    return matches[0]


async def assert_write_unchanged(d, before):
    after = await d.config()
    assert after["version"] == before["version"]
    assert after["pipeline_config"] == before["pipeline_config"]


async def bound_budget(d, *, policy=None, required=False):
    # Direct persistence represents an authorized existing binding, not a
    # production activation path. Activation has separate HTTP tests.
    _, execution, _ = await d.bound()

    def configure(p):
        p["context_budget"] = dict(policy or SMALL_POLICY)
        sources = p["stages"][0]["llm"]["context_sources"]
        p["stages"][0]["llm"]["context_sources"] = [dict(sources[0], required=required)]

    await d.store(configure)
    return execution, await d.current(execution)


async def history(d, execution):
    response = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                    headers=d.headers("recipient"))
    assert response.status_code == 200, response.text
    assert isinstance(response.json(), list)
    return response.json()
