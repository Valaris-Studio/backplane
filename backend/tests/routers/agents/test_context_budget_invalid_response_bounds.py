# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Invalid persisted budget errors do not echo unbounded configuration keys."""

import json

import pytest

from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    expected_block,
    source,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]

INVALID_POLICY_RESPONSE_MAX_BYTES = 4096


@pytest.mark.parametrize("shape", ["long_key", "many_keys"])
async def test_persisted_unknown_budget_keys_have_bounded_opaque_http_error(
    budget_case, shape, record_property,
):
    keys = (
        ["private_config_key_" + "é🧪" * 4096]
        if shape == "long_key" else
        [f"private_config_key_{index:04d}_" + "x" * 64 for index in range(256)]
    )
    await budget_case.configure([source()], **dict.fromkeys(keys, True))
    response = await budget_case.refresh()
    assert response.status_code == 409, response.text[:500]
    payload = response.json()
    assert payload["error_code"] == "context_budget_invalid"
    assert isinstance(payload.get("detail"), str) and payload["detail"].strip()
    decoded_response = json.dumps(payload, ensure_ascii=False)
    observation = {
        "shape": shape,
        "stored_unknown_key_count": len(keys),
        "stored_unknown_key_bytes": sum(len(key.encode("utf-8")) for key in keys),
        "response_bytes": len(response.content),
        "echoed_unknown_key_count": sum(key in decoded_response for key in keys),
        "status_code": response.status_code,
        "error_code": payload["error_code"],
    }
    record_property("invalid_budget_response_observation", json.dumps(observation))
    assert (
        observation["response_bytes"] <= INVALID_POLICY_RESPONSE_MAX_BYTES
        and observation["echoed_unknown_key_count"] == 0
    ), observation


async def test_short_invalid_budget_keeps_actionable_bounded_conflict(budget_case):
    await budget_case.configure([source()], version="1")
    response = await budget_case.refresh()
    assert response.status_code == 409, response.text[:500]
    payload = response.json()
    assert payload["error_code"] == "context_budget_invalid"
    assert isinstance(payload.get("detail"), str) and payload["detail"].strip()
    assert len(response.content) <= INVALID_POLICY_RESPONSE_MAX_BYTES


async def test_valid_budget_still_returns_exact_context_and_effective_policy(budget_case):
    note, = await budget_case.seed([{"content": "Approved bounded context é🧪"}])
    await budget_case.configure([source()])
    response = await budget_case.refresh()
    assert response.status_code == 200, response.text[:500]
    payload = response.json()
    assert payload["context"] == {"Contexté47": expected_block(note)}
    assert payload["context_manifest"]["budget"]["policy"] == DEFAULT_POLICY
