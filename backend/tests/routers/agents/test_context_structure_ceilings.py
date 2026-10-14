# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Lower instance limits exercised through authorized HTTP assembly."""

import json

import pytest

from app.config import settings
from tests.routers.agents.context_budgets_support import (
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    compact_json,
    expected_block,
    source,
    utf8,
)
from tests.routers.agents.context_structure_support import (
    depth_document,
    node_document,
    observe_note_queries,
)
from tests.routers.agents.test_context_budget_settings import ceiling_values, instance_settings

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


def install_instance_limits(monkeypatch, **overrides):
    configured = instance_settings(monkeypatch, overrides)
    assert all(ceiling_values(configured)[key] == value for key, value in overrides.items())
    # Install a real validated Settings field for this isolated request only.
    # No assembly/repository/renderer path is replaced or mocked.
    monkeypatch.setattr(settings, "CONTEXT_BUDGET_CEILINGS", configured.CONTEXT_BUDGET_CEILINGS)


@pytest.mark.parametrize("count", [2, 3])
async def test_lowered_source_ceiling_is_enforced_before_note_query(budget_case, monkeypatch, count):
    install_instance_limits(monkeypatch, max_sources=2)
    case = budget_case
    note, = await case.seed([{"content": "visible"}])
    await case.configure([source(alias=f"Choice{index}") for index in range(count)])
    with observe_note_queries(case.engine) as queries:
        response = await case.refresh()
    if count == 2:
        assert response.status_code == 200 and queries
        assert response.json()["context"] == {f"Choice{index}": expected_block(note) for index in range(2)}
    else:
        assert response.status_code == 409 and queries == []
        assert response.json()["error_code"] == "context_source_limit_exceeded"
        assert response.json()["context"] == {"source_limit": 2, "source_count": 3}


@pytest.mark.parametrize("shape", ["depth", "nodes"])
async def test_lowered_structural_ceiling_retains_later_small_record(budget_case, monkeypatch, shape):
    install_instance_limits(monkeypatch, **({"max_json_depth": 8} if shape == "depth" else
                                           {"max_json_nodes": 20}))
    case = budget_case
    stored = compact_json(depth_document(9) if shape == "depth" else node_document(21))
    rejected, later = await case.seed([{"content": stored}, {"content": "later small"}])
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": expected_block(later)}
    diagnostics = response.json()["context_manifest"]["diagnostics"]
    entry, = diagnostics["entries"]
    assert entry["note_id"] == rejected["id"]
    assert entry["reason"] == f"structure_{'depth' if shape == 'depth' else 'node'}_limit"
    assert entry["rendered_bytes"] is None and entry["revision_sha256"] is None


async def test_diagnostic_entry_limit_omits_whole_entries_and_keeps_full_counts(budget_case, monkeypatch):
    install_instance_limits(monkeypatch, max_diagnostic_entries=2)
    case = budget_case
    rejected = await case.seed([{"content": compact_json(depth_document(129))} for _ in range(4)])
    later, = await case.seed([{"content": "later small"}])
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": expected_block(later)}
    report = response.json()["context_manifest"]["diagnostics"]
    assert [entry["note_id"] for entry in report["entries"]] == [note["id"] for note in rejected[:2]]
    assert [entry["candidate_index"] for entry in report["entries"]] == [0, 1]
    assert report["excluded_count"] == 4
    assert report["reason_counts"] == {"structure_depth_limit": 4}
    assert report["truncated"] is True


@pytest.mark.parametrize("required", [False, True])
async def test_512_byte_diagnostics_return_complete_envelope_without_partial_entry(
    budget_case, monkeypatch, required,
):
    install_instance_limits(monkeypatch, max_diagnostic_bytes=512)
    case = budget_case
    title = "🧭" * 200
    rejected, later = await case.seed([
        {"title": title, "content": compact_json(depth_document(129))}, {"content": "later small"},
    ])
    await case.configure([source(required=required)])
    response = await case.refresh()
    assert response.status_code == (409 if required else 200), response.text[:500]
    if required:
        assert response.json()["error_code"] == "context_budget_exceeded"
        manifest = response.json()["context"]
    else:
        assert response.json()["context"] == {"Contexté47": expected_block(later)}
        manifest = response.json()["context_manifest"]
    report = manifest["diagnostics"]
    assert report == {"entries": [], "excluded_count": 1,
                      "reason_counts": {"structure_depth_limit": 1}, "truncated": True}
    encoded = compact_json(report)
    assert utf8(encoded) <= 512 and json.loads(encoded) == report
    assert rejected["title"] not in response.text


async def test_fixed_reason_count_envelope_fits_minimum_diagnostic_bytes():
    # Feasibility control for the fixed wire envelope, not a product CPU bound.
    reasons = ("raw_body_limit", "fetch_budget", "record_too_large", "source_budget",
               "total_budget", "structure_depth_limit", "structure_node_limit")
    counts = dict.fromkeys(reasons, 1600 // len(reasons))
    counts[reasons[-1]] += 1600 % len(reasons)
    envelope = {"entries": [], "excluded_count": sum(counts.values()),
                "reason_counts": counts, "truncated": True}
    encoded = compact_json(envelope)
    assert utf8(encoded) <= 512
    assert json.loads(encoded) == envelope
