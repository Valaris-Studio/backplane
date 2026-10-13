# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored B1 phase-1 contracts beyond the independent frozen set:
strict policy refusal, body-query scope/size guards, atomic non-note blocks and
required failure during preparation."""

import uuid

import pytest
from sqlalchemy import select

from app.models.definitions.definition import Definition
from app.models.workspace_config import WorkspaceConfig
from app.repositories.notes.context_note import ContextNoteHeader, ContextNoteRepository
from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    assert_manifest,
    expected_block,
    note_for_source,
    observe_notes,
    source,
    utf8,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


async def _store_budget(case, sources, budget):
    async with case.receipt.factory() as session:
        config = (await session.execute(select(WorkspaceConfig).where(
            WorkspaceConfig.workspace_id == uuid.UUID(case.receipt.workspace["id"]),
        ))).scalar_one()
        pipeline = dict(config.pipeline_config)
        stages = [dict(stage) for stage in pipeline["stages"]]
        stages[0]["llm"] = {**stages[0]["llm"], "context_sources": sources}
        config.pipeline_config = {**pipeline, "stages": stages, "context_budget": budget}
        await session.commit()


@pytest.mark.parametrize("budget, sources", [
    ({**DEFAULT_POLICY, "unlimited": True}, [source()]),
    ({**DEFAULT_POLICY, "max_note_body_bytes": True}, [source()]),
    ({**DEFAULT_POLICY, "max_note_body_bytes": 0}, [source()]),
    ({**DEFAULT_POLICY, "max_note_body_bytes": 1048577}, [source()]),
    ({**DEFAULT_POLICY, "max_optional_note_bytes": 131073,
      "max_managed_context_bytes": 131072}, [source()]),
    ({**DEFAULT_POLICY, "max_note_fetch_bytes": 64, "max_note_body_bytes": 65}, [source()]),
    ({**DEFAULT_POLICY, "version": True}, [source()]),
    ({**DEFAULT_POLICY, "version": "1"}, [source()]),
    ({**DEFAULT_POLICY, "version": 2}, [source()]),
    (None, [source()]),
    (DEFAULT_POLICY, [source(required="yes")]),
    (DEFAULT_POLICY, [source(max_rendered_bytes=131073)]),
    (DEFAULT_POLICY, [source(max_rendered_bytes=None)]),
    (DEFAULT_POLICY, [source("pinned_notes", filter={"limit": 51})]),
    (DEFAULT_POLICY, [source("review_history", filter={"limit": 0})]),
    (DEFAULT_POLICY, [source("board_definition", filter={"limit": "5"})]),
])
async def test_unsupported_stored_budget_is_refused_before_any_note_read(budget_case, budget, sources):
    case = budget_case
    await case.seed([note_for_source(sources[0]["kind"], content="never-read-é")])
    await _store_budget(case, sources, budget)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_budget_invalid"
    assert not observed.body_reads
    assert not observed.header_ids
    assert observed.orm_loads == []


@pytest.mark.parametrize("budget", [{}, {"max_note_body_bytes": 1024}])
async def test_partial_budget_without_version_opts_in_with_inherited_defaults(budget_case, budget):
    case = budget_case
    note, = await case.seed([{"content": "inherits-é"}])
    await _store_budget(case, [source()], budget)
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    block = expected_block(note)
    assert response.json()["context"] == {"Contexté47": block}
    assert_manifest(response.json(), budget, fetched=utf8(note["content"]), rendered=utf8(block))


async def test_card_notes_keep_existing_limit_clamp_under_a_budget(budget_case):
    case = budget_case
    notes = await case.seed([{"content": f"clamped-{index}"} for index in range(3)])
    await case.configure([source(filter={"limit": 500})])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    admission = response.json()["context_manifest"]["sources"][0]["admission"]
    assert admission["candidate_limit"] == 50
    assert admission["candidate_count"] == len(notes)


async def test_body_query_repeats_scope_so_a_foreign_header_never_transfers_its_body(
    budget_case, monkeypatch,
):
    case = budget_case
    foreign, = await case.seed([{"scope": "other_card", "content": "FOREIGN_BODY_é"}])
    await case.configure([source()])

    async def foreign_header(self, scope, *, limit):
        # Simulates a header window that drifted onto another card's note.
        return [ContextNoteHeader(
            uuid.UUID(foreign["id"]), foreign["title"], foreign["kind"], True,
            foreign["created_at"], utf8(foreign["content"]),
        )], False

    monkeypatch.setattr(ContextNoteRepository, "list_headers", foreign_header)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_selection_changed"
    assert "FOREIGN_BODY" not in response.text
    assert not observed.body_reads


async def test_body_query_enforces_sql_size_even_when_the_header_said_small(budget_case, monkeypatch):
    case = budget_case
    grown, = await case.seed([{"content": "grown-after-header:" + "g" * 4096}])
    await case.configure([source()], max_note_body_bytes=1024)

    async def stale_small_header(self, scope, *, limit):
        return [ContextNoteHeader(
            uuid.UUID(grown["id"]), grown["title"], grown["kind"], True, grown["created_at"], 10,
        )], False

    monkeypatch.setattr(ContextNoteRepository, "list_headers", stale_small_header)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_selection_changed"
    assert not observed.body_reads


async def test_header_body_metadata_drift_is_a_stale_selection(budget_case, monkeypatch):
    case = budget_case
    note, = await case.seed([{"content": "drifted-é"}])
    await case.configure([source()])
    original = ContextNoteRepository.list_headers

    async def renamed_header(self, scope, *, limit):
        headers, more = await original(self, scope, limit=limit)
        return [ContextNoteHeader(h.id, "Renamed since", h.kind, h.pinned, h.created_at,
                                  h.raw_bytes) for h in headers], more

    monkeypatch.setattr(ContextNoteRepository, "list_headers", renamed_header)
    response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert response.json()["error_code"] == "context_selection_changed"
    assert note["content"] not in response.text


async def test_board_definition_part_is_one_atomic_block_ahead_of_its_note_window(budget_case):
    case = budget_case
    async with case.receipt.factory() as session:
        session.add(Definition(
            board_id=uuid.UUID(case.receipt.board_id),
            workspace_id=uuid.UUID(case.receipt.workspace["id"]),
            scope="S" * 300, content={}, updated_by=uuid.UUID(case.receipt.recipient_id),
        ))
        await session.commit()
    note, = await case.seed([note_for_source("board_definition", content="pinned-é")])
    block = expected_block(note, "board_definition")
    selected = source("board_definition", max_rendered_bytes=utf8(block))
    await case.configure([selected])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    payload = response.json()
    assert payload["context"] == {"Contexté47": block}
    manifest = assert_manifest(payload, fetched=utf8(note["content"]), rendered=utf8(block))
    admission = manifest["sources"][0]["admission"]
    # The excluded definition part is a candidate too, consistent with diagnostics.
    assert (admission["candidate_count"], admission["admitted_count"]) == (2, 1)
    assert admission["excluded_count"] == manifest["diagnostics"]["excluded_count"] == 1
    entry, = manifest["diagnostics"]["entries"]
    assert entry == {
        "source_index": 0, "candidate_index": None, "note_id": None, "title": None,
        "kind": "board_definition", "raw_body_bytes": None,
        "rendered_bytes": utf8("PROJECT SCOPE:\n" + "S" * 300), "revision_sha256": None,
        "reason": "source_budget",
    }


async def test_non_note_source_is_admitted_whole_or_excluded_whole(budget_case):
    case = budget_case
    await case.configure([source("pipeline_expectations", alias="Expect", max_rendered_bytes=8)])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    payload = response.json()
    assert payload["context"] == {"Expect": ""}
    manifest = assert_manifest(payload, fetched=0, rendered=0)
    assert manifest["sources"][0]["admission"] == {
        "required": False, "outcome": "excluded", "candidate_limit": None,
        "candidate_count": 1, "has_more_candidates": False, "admitted_count": 0,
        "excluded_count": 1, "max_rendered_bytes": 8,
    }
    assert manifest["diagnostics"]["reason_counts"] == {"source_budget": 1}


async def test_required_empty_source_fails_without_reading_optional_sources(budget_case):
    case = budget_case
    optional, = await case.seed([note_for_source("pinned_notes", content="optional-é")])
    await case.configure([
        source("pinned_notes", alias="Optional"),
        source("review_history", alias="Required", required=True),
    ])
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    payload = response.json()
    assert payload["error_code"] == "context_budget_exceeded"
    assert [s["alias"] for s in payload["context"]["sources"]] == ["Required"]
    assert payload["context"]["sources"][0]["admission"]["outcome"] == "empty"
    assert optional["id"] not in observed.header_ids
    assert not observed.body_reads


async def test_required_failure_prepares_no_receipt(budget_case):
    case = budget_case
    await case.seed([{"content": "legacy-é"}])
    await case.configure([source()], enforced=False)
    legacy = (await case.refresh()).json()
    await case.configure([source(required=True)], max_note_body_bytes=4)
    prepared = await case.receipt.prepare(case.execution, legacy, prompt="anything")
    assert prepared.status_code == 409, prepared.text[:500]
    assert prepared.json()["error_code"] == "context_budget_exceeded"
    history = await case.receipt.http.get(
        case.receipt.execution_path(case.execution["id"]) + "/context-receipts",
        headers=case.receipt.headers["recipient"],
    )
    assert history.status_code == 200
    assert history.json() == []
    assert history.headers["X-Total-Count"] == "0"


@pytest.mark.parametrize("kind", ["pinned_notes", "board_definition", "review_history"])
async def test_ineligible_notes_never_enter_an_unfilled_window(budget_case, kind):
    # A full window hides a dropped predicate behind ordering; a sparse one cannot.
    case = budget_case
    eligible, = await case.seed([note_for_source(kind, content="eligible-é")])
    ineligible = [note_for_source(kind, content="ineligible-unpinned", pinned=False)]
    if kind == "board_definition":
        ineligible.append(note_for_source(kind, content=""))
    if kind == "review_history":
        ineligible = [{**note_for_source(kind, content="ineligible-kind"), "kind": "plan"}]
    ineligible = await case.seed(ineligible)
    await case.configure([source(kind)])
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert observed.header_ids == {eligible["id"]}
    payload = response.json()
    assert payload["context"] == {"Contexté47": expected_block(eligible, kind)}
    admission = payload["context_manifest"]["sources"][0]["admission"]
    assert (admission["candidate_count"], admission["has_more_candidates"]) == (1, False)
