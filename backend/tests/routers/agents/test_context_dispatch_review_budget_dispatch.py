# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression (review M2): a budget opt-in persisted
after an execution was bound must not let that execution refresh or prepare
unbounded context. Post-B1 milestone (root-authorized): the bound execution
sees the enforced schema-2 snapshot, its stale preparation is refused, and an
unresolvable persisted policy is a bounded context_budget_invalid."""

import pytest

from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


def _opt_in(place):
    budget = {"version": 1, "max_invocation_bytes": 262144}

    def apply(pipeline):
        if place == "workspace":
            pipeline["context_budget"] = budget
        elif place == "stage":
            pipeline["stages"][0]["llm"]["context_budget"] = budget
        elif place == "source_cap":
            pipeline["stages"][0]["llm"]["context_sources"][0]["max_rendered_bytes"] = 1024
        else:
            pipeline["stages"][0]["lifecycle"][1]["params"]["context_budget"] = budget
    return apply


@pytest.mark.parametrize("place", ["workspace", "stage", "source_cap", "other_step"])
async def test_bound_execution_refreshes_bounded_and_never_prepares_stale_unbounded_context(dispatch_case, place):
    d = dispatch_case
    if place == "other_step":
        await d.store(two_steps)
    _, execution, _ = await d.bound()
    payload = d.payload(await d.current(execution))
    await d.store(_opt_in(place))

    snapshot = await d.snapshot(execution)
    assert snapshot.status_code == 200, snapshot.text
    prepared = await d.prepare(execution, payload)
    if place == "other_step":
        # Another step's opt-in does not budget this stage call: unchanged
        # revisions, ordinary preparation.
        assert snapshot.json()["context_manifest"]["schema_version"] == 1
        assert prepared.status_code == 201, prepared.text
    else:
        assert snapshot.json()["context_manifest"]["schema_version"] == 2
        assert prepared.status_code == 409, prepared.text
        assert {"execution_context_changed", "execution_dispatch_changed"} & finding_codes(prepared)

    await d.store(lambda p: p.update(context_budget={"max_invocation_bytes": True}))
    invalid = await d.snapshot(execution)
    assert invalid.status_code == 409 and "context_budget_invalid" in finding_codes(invalid)
    history = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                    headers=d.headers("recipient"))
    assert history.status_code == 200
    assert len(history.json()) == (1 if place == "other_step" else 0)
