# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored regressions for the independent phase-1 review
(F-1..F-4 findings and T1..T4 test gaps)."""

import uuid
from datetime import timedelta

import pytest

from app.models.definitions.definition import Definition
from app.repositories.notes.context_note import ContextNoteHeader, ContextNoteRepository
from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    compact_json,
    expected_block,
    note_for_source,
    observe_notes,
    source,
    utf8,
)
from tests.routers.agents.test_context_budgets_implementer import _store_budget

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]

DEFINITION_PART = "PROJECT SCOPE:\n" + "S" * 300


async def _add_definition(case):
    async with case.receipt.factory() as session:
        session.add(Definition(
            board_id=uuid.UUID(case.receipt.board_id),
            workspace_id=uuid.UUID(case.receipt.workspace["id"]),
            scope="S" * 300, content={}, updated_by=uuid.UUID(case.receipt.recipient_id),
        ))
        await session.commit()


async def test_f1_required_definition_only_source_is_a_complete_candidate_not_empty(budget_case):
    case = budget_case
    await _add_definition(case)
    await case.configure([source("board_definition", required=True)])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": DEFINITION_PART}
    admission = response.json()["context_manifest"]["sources"][0]["admission"]
    assert admission == {
        "required": True, "outcome": "complete", "candidate_limit": 50, "candidate_count": 1,
        "has_more_candidates": False, "admitted_count": 1, "excluded_count": 0,
        "max_rendered_bytes": DEFAULT_POLICY["max_managed_context_bytes"],
    }


async def test_f1_excluded_definition_part_counts_in_admission_like_diagnostics(budget_case):
    case = budget_case
    await _add_definition(case)
    note, = await case.seed([note_for_source("board_definition", content="pinned-é")])
    block = expected_block(note, "board_definition")
    await case.configure([source("board_definition", max_rendered_bytes=utf8(block))])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    manifest = response.json()["context_manifest"]
    admission = manifest["sources"][0]["admission"]
    assert (admission["outcome"], admission["candidate_count"], admission["admitted_count"],
            admission["excluded_count"]) == ("partial", 2, 1, 1)
    assert admission["excluded_count"] == manifest["diagnostics"]["excluded_count"]


@pytest.mark.parametrize("sources", [
    [{"kind": "no_such_kind", "as": "Must", "required": True}],
    [{"kind": "review_history", "as": 7, "required": True}],
    [{"kind": "review_history", "as": ["Must"], "required": True}],
    [source(alias="Kept"), {"kind": "no_such_kind", "as": "Optional"}],
])
async def test_f2_unusable_persisted_source_is_refused_not_dropped(budget_case, sources):
    case = budget_case
    await case.seed([{"content": "never-read-é"}])
    await _store_budget(case, sources, DEFAULT_POLICY)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_budget_invalid"
    assert not observed.header_ids and not observed.body_reads


@pytest.mark.parametrize("selected", [
    source("pinned_notes", filter="limit"),
    source("card_notes", filter=["limit"]),
    source("review_history", filter=5),
])
async def test_f3_non_object_filter_is_a_bounded_invalid_policy_not_500(budget_case, selected):
    case = budget_case
    await _store_budget(case, [selected], DEFAULT_POLICY)
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_budget_invalid"


@pytest.mark.parametrize("aliases", [
    ["A" * 70000],
    [f"Required{index}-" + "é" * 1500 for index in range(30)],
])
async def test_f4_required_failure_envelope_bounds_whole_source_entries_with_full_count(budget_case, aliases):
    case = budget_case
    await case.configure([source("review_history", alias=alias, required=True) for alias in aliases])
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    context = response.json()["context"]
    assert context["required_source_count"] == len(aliases)
    assert context["sources_truncated"] is True
    assert utf8(compact_json(context["sources"])) <= 65536
    assert 0 <= len(context["sources"]) < len(aliases)
    for entry in context["sources"]:
        assert entry["alias"] == aliases[entry["source_index"]]
        assert entry["admission"]["outcome"] == "empty"
    assert [entry["source_index"] for entry in context["sources"]] == list(range(len(context["sources"])))


async def test_t1_body_guard_uses_the_remaining_fetch_allowance_not_only_the_body_cap(budget_case, monkeypatch):
    case = budget_case
    first, grown = await case.seed([{"content": "a" * 40}, {"content": "b" * 50}])
    await case.configure([source()], max_note_body_bytes=60, max_note_fetch_bytes=60)
    original = ContextNoteRepository.list_headers

    async def understated(self, scope, *, limit):
        headers, more = await original(self, scope, limit=limit)
        # The second body "grew" past the 20 bytes still allowed, yet under the body cap.
        return [h if str(h.id) != grown["id"] else ContextNoteHeader(
            h.id, h.title, h.kind, h.pinned, h.created_at, 10) for h in headers], more

    monkeypatch.setattr(ContextNoteRepository, "list_headers", understated)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_selection_changed"
    assert observed.body_reads[first["id"]] == 1
    assert observed.body_reads[grown["id"]] == 0


async def test_t2_partially_admitted_required_source_fails_whole(budget_case):
    case = budget_case
    await case.seed([{"content": "small-é"}, {"content": "oversize-" + "x" * 80}])
    await case.configure([source(required=True)], max_note_body_bytes=64)
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    payload = response.json()
    assert payload["error_code"] == "context_budget_exceeded"
    admission = payload["context"]["sources"][0]["admission"]
    assert (admission["outcome"], admission["admitted_count"], admission["excluded_count"]) == ("partial", 1, 1)


async def test_t3_created_at_drift_between_header_and_body_is_a_changed_selection(budget_case, monkeypatch):
    case = budget_case
    await case.seed([{"content": "dated-é"}])
    await case.configure([source()])
    original = ContextNoteRepository.list_headers

    async def redated(self, scope, *, limit):
        headers, more = await original(self, scope, limit=limit)
        return [ContextNoteHeader(h.id, h.title, h.kind, h.pinned, h.created_at + timedelta(seconds=1),
                                  h.raw_bytes) for h in headers], more

    monkeypatch.setattr(ContextNoteRepository, "list_headers", redated)
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_selection_changed"


def _envelope_bytes(entries, *, truncated):
    return utf8(compact_json({
        "entries": entries, "excluded_count": len(entries),
        "reason_counts": {"raw_body_limit": len(entries)}, "truncated": truncated,
    }))


async def test_t4_diagnostics_are_priced_with_the_longer_flag_at_the_exact_byte_boundary(budget_case):
    case = budget_case

    def entry(index, title, content):
        return {"source_index": 0, "candidate_index": index, "note_id": str(uuid.UUID(int=1001 + index)),
                "title": title, "kind": "user_note", "raw_body_bytes": utf8(content),
                "rendered_bytes": None, "revision_sha256": None, "reason": "raw_body_limit"}

    contents = [f"reject-{index}-" + "x" * 80 for index in range(40)]
    full = "🧭" * 500
    for count in range(2, 40):
        entries = [entry(i, full, contents[i]) for i in range(count - 1)] + [entry(count - 1, "", contents[count - 1])]
        missing = 65537 - _envelope_bytes(entries, truncated=False)
        if 0 <= missing <= 4 * 499:
            break
    emoji, ascii_tail = divmod(missing, 4)
    titles = [full] * (count - 1) + ["🧭" * emoji + "a" * ascii_tail]
    entries = [entry(i, titles[i], contents[i]) for i in range(count)]
    # All entries together are exactly one byte over the cap when reported untruncated.
    assert _envelope_bytes(entries, truncated=False) == 65537
    await case.seed([{"number": i + 1, "title": titles[i], "content": contents[i]} for i in range(count)])
    await case.configure([source()], max_note_body_bytes=64)
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    report = response.json()["context_manifest"]["diagnostics"]
    assert utf8(compact_json(report)) <= 65536
    assert report["truncated"] is True
    assert report["entries"] == entries[:-1]
    assert report["excluded_count"] == count
