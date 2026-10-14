# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored pins from the structure/ceilings review (S-2, S-3)."""

import pytest

from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    expected_block,
    source,
    utf8,
)
from tests.routers.agents.context_structure_support import deep_stored_document
from tests.routers.agents.test_context_budgets_implementer import _store_budget
from tests.routers.agents.test_context_structure_ceilings import install_instance_limits

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


async def test_whitespace_prefixed_over_deep_body_is_still_scanned_before_decode(budget_case):
    case = budget_case
    stored = " \n\t " + deep_stored_document(4096)
    assert utf8(stored) < DEFAULT_POLICY["max_note_body_bytes"]
    rejected, later = await case.seed([{"content": stored}, {"content": "later small é"}])
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": expected_block(later)}
    entry, = response.json()["context_manifest"]["diagnostics"]["entries"]
    assert (entry["note_id"], entry["reason"]) == (rejected["id"], "structure_depth_limit")


@pytest.mark.parametrize("stored, status", [
    ({"version": 1}, 409),
    ({}, 409),
    ({"max_note_body_bytes": 1024}, 200),
])
async def test_inherited_default_above_a_lowered_ceiling_needs_explicit_tightening(
    budget_case, monkeypatch, stored, status,
):
    install_instance_limits(monkeypatch, max_note_body_bytes=1024)
    case = budget_case
    await case.seed([{"content": "ceiling-bound-é"}])
    await _store_budget(case, [source()], stored)
    response = await case.refresh()
    assert response.status_code == status, response.text[:500]
    if status == 409:
        assert response.json()["error_code"] == "context_budget_invalid"
