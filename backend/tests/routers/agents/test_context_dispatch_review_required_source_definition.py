# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression (review M1): a required source's whole
definition is protected policy, not just the fact that something at that
location is required. An agent key keeping `required: true` must not
retarget, rename or replace the source."""

import copy

import pytest

from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    two_steps,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


def _flat_required(pipeline):
    pipeline["stages"][0]["llm"]["context_sources"][0]["required"] = True


def _change(pipeline, change, place):
    source = (pipeline["stages"][0]["llm"]["context_sources"][0] if place == "flat"
              else pipeline["stages"][0]["lifecycle"][1]["params"]["context_sources"][0])
    if change == "filter":
        source["filter"] = {"kind": "review_verdict", "limit": 1}
    elif change == "alias":
        source["as"] = "RenamedRequired47"
    else:
        source.clear()
        source.update({"kind": "pinned_notes", "as": "ReplacedRequired47", "required": True})
    assert source["required"] is True


@pytest.mark.parametrize("change", ["filter", "alias", "replace"])
@pytest.mark.parametrize("place", ["flat", "second_step"])
async def test_agent_key_cannot_rewrite_a_required_source(dispatch_case, change, place):
    d = dispatch_case
    await d.store(_flat_required if place == "flat" else two_steps)
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    _change(pipeline, change, place)
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


async def test_human_operator_may_still_rewrite_a_required_source(dispatch_case):
    d = dispatch_case
    await d.store(_flat_required)
    pipeline = (await d.config())["pipeline_config"]
    _change(pipeline, "filter", "flat")
    response = await d.write(pipeline)
    assert response.status_code == 200, response.text


async def test_agent_key_may_still_edit_an_optional_source(dispatch_case):
    d = dispatch_case
    await d.store(_flat_required)
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["llm"]["context_sources"][2]["filter"] = {"kind": "user_note", "limit": 1}
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 200, response.text
