# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regression (review L2): the stored enrollment version
is an integer-only protocol value; 1.0 must not be persisted as version 1."""

import copy

import pytest

from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


@pytest.mark.parametrize("version", [1.0, "1", None, False])
async def test_enrollment_version_must_be_the_integer_one(dispatch_case, version):
    d = dispatch_case
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["context_dispatch"] = {"version": version, "required_agent_ids": [d.case.agent_id]}
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    assert "invalid_context_dispatch" in finding_codes(response)
    after = await d.config()
    assert after["pipeline_config"] == before["pipeline_config"]
    assert after["version"] == before["version"]
