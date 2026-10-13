# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored A2 regressions beyond the independent frozen suite."""

import copy
import re

import pytest
from sqlalchemy import event

from app.services.agents.dispatch_inclusion import verify_inclusion
from tests.routers.agents.context_dispatch_support import (
    HEADER,
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)
from tests.routers.agents.context_receipts_support import ALIAS

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def _history(d, execution):
    response = await d.case.http.get(d.case.execution_path(execution["id"]) + "/context-receipts",
                                     headers=d.headers("recipient"))
    assert response.status_code == 200, response.text
    return response.json()


def test_union_bytes_merge_contained_and_overlapping_occurrences_per_channel():
    blocks = ["abab", "bab", "zz", ""]
    result = verify_inclusion(blocks, [True, False, False, False], ["A", "B", "C", "D"],
                              input_prompt="xababab", system_prompt="bab")
    spans = {i["alias"]: [(s["channel"], s["start"], s["end"]) for s in i["spans"]]
             for i in result.source_inclusions}
    # Overlapping self-occurrences are each retained as evidence...
    assert spans["A"] == [("input", 1, 5), ("input", 3, 7)]
    assert spans["B"] == [("input", 2, 5), ("input", 4, 7), ("system", 0, 3)]
    assert result.source_inclusions[0]["contribution_bytes"] == 8
    # ...but distinct injected bytes are the union per channel, never a sum.
    assert result.injected_bytes == {"input": 6, "system": 3, "total": 9}
    assert [i["outcome"] for i in result.source_inclusions] == [
        "exact", "exact", "exact_block_not_observed", "empty",
    ]
    assert result.source_inclusions[2]["contribution_bytes"] is None
    assert result.missing_required == []


def test_multibyte_offsets_are_utf8_bytes_not_characters():
    result = verify_inclusion(["🧪é"], [True], ["A"], input_prompt="é🧪é", system_prompt="")
    assert result.source_inclusions[0]["spans"] == [{"channel": "input", "start": 2, "end": 8}]


async def test_a1_route_never_replays_a_dispatch_receipt_key(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    payload = d.payload(snapshot)
    assert (await d.prepare(execution, payload)).status_code == 201
    a1 = {key: payload[key] for key in
          ("client_request_id", "context_revision", "input_prompt", "system_prompt", "provider", "model")}
    response = await d.case.http.post(d.case.execution_path(execution["id"]) + "/context-receipts",
                                      json=a1, headers=d.headers())
    # The A1 route cannot express dispatch identity, so it must not hand back
    # the dispatch receipt as if it had prepared it.
    assert response.status_code == 409, response.text
    assert "context_receipt_conflict" in finding_codes(response)


async def test_history_page_never_selects_dispatch_detail(dispatch_case, db_engine):
    d = dispatch_case
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    assert (await d.prepare(execution, d.payload(snapshot))).status_code == 201
    statements = []

    def capture(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(db_engine.sync_engine, "before_cursor_execute", capture)
    try:
        rows = await _history(d, execution)
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", capture)
    assert rows[0]["dispatch_summary"]["protocol_version"] == 1
    heavy = re.compile(r"\bexecution_context_receipts\.(dispatch|input_prompt|system_prompt|context_manifest)\b")
    reads = [s.split("FROM execution_context_receipts")[0] for s in statements
             if "FROM execution_context_receipts" in s]
    assert reads and not any(heavy.search(selected) for selected in reads), reads


async def test_overwritten_duplicate_alias_is_not_delivered_by_the_survivor(dispatch_case):
    d = dispatch_case

    def duplicate(pipeline):
        # Legacy stored data: today's validator rejects duplicate aliases.
        sources = pipeline["stages"][0]["llm"]["context_sources"]
        sources[0]["required"] = True
        sources[1]["as"] = ALIAS

    await d.store(duplicate)
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    first_block = snapshot["context_manifest"]["sources"][0]
    survivor = snapshot["context"][ALIAS]
    assert snapshot["dispatch"]["required_source_indices"] == [0]
    assert len(survivor.encode()) != first_block["rendered_bytes"]
    response = await d.prepare(execution, d.payload(snapshot, input_prompt="Only " + survivor))
    assert response.status_code == 422, response.text
    assert "required_context_not_verbatim" in finding_codes(response)


async def test_lifecycle_step_sources_are_fully_validated(dispatch_case):
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["lifecycle"] = [
        {"name": "call", "kind": "llm", "params": {
            "stage": "continue_project", "context_sources": [{"kind": "not_a_source_kind"}]}},
        {"name": "done", "kind": "end", "params": {}},
    ]
    response = await d.write(pipeline)
    assert response.status_code == 422, response.text
    assert "unknown_context_source_kind" in finding_codes(response)


async def test_workspace_wide_required_source_refuses_activation_over_legacy_work(dispatch_case):
    d = dispatch_case
    assignment = await d.case.assignment()
    await d.case.start(assignment)
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["llm"]["context_sources"][0]["required"] = True
    response = await d.write(pipeline)
    assert response.status_code == 409, response.text
    assert "context_dispatch_legacy_execution_active" in finding_codes(response)
    assert "required" not in (await d.config())["pipeline_config"]["stages"][0]["llm"]["context_sources"][0]


async def test_agent_key_cannot_redirect_auxiliary_prompt_slots(dispatch_case):
    d = dispatch_case
    await d.enroll()
    before = await d.config()
    pipeline = copy.deepcopy(before["pipeline_config"])
    pipeline["stages"][0]["llm"]["prompt_slots"] = {
        "rework_implement": {"role": "attacker_role", "stage": "attacker_stage"},
    }
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 403, response.text
    assert (await d.config())["pipeline_config"] == before["pipeline_config"]


async def test_prompt_slots_on_a_legacy_pipeline_are_an_ordinary_edit(dispatch_case):
    # Inert without any floor: seeding/editing them must not need an operator.
    d = dispatch_case
    pipeline = (await d.config())["pipeline_config"]
    pipeline["stages"][0]["llm"]["prompt_slots"] = {
        "rework_implement": {"role": "any_role", "stage": "any_stage"},
    }
    response = await d.write(pipeline, actor="agent")
    assert response.status_code == 200, response.text


async def test_unsupported_header_on_dispatch_context_is_refused(dispatch_case):
    d = dispatch_case
    _, execution, _ = await d.bound()
    response = await d.case.http.get(
        d.case.execution_path(execution["id"]) + "/dispatch-context",
        params={"invocation_kind": "stage", "prompt_slot": "main"},
        headers={**d.headers(), HEADER: "2"},
    )
    assert response.status_code == 422, response.text
    assert "input_template" not in response.text


async def test_legacy_bound_execution_cannot_use_the_dispatch_protocol(dispatch_case):
    d = dispatch_case
    assignment = await d.case.assignment()
    execution = await d.case.start(assignment)
    response = await d.snapshot(execution)
    assert response.status_code == 409, response.text
    assert "context_dispatch_version_required" in finding_codes(response)
