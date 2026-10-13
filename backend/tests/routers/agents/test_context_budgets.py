# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent B1 guarded-note contracts through authenticated A1 refresh."""

import copy
import uuid

import pytest
from sqlalchemy import update

from app.models.notes.note import Note
from tests.routers.agents.context_budgets_support import (
    NOTE_SOURCES,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    assert_guarded,
    assert_manifest,
    compact_json,
    expected_block,
    note_for_source,
    observe_notes,
    source,
    utf8,
)
from tests.routers.agents.context_receipts_support import note_revision

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


def admission(*, count, admitted, limit=50, required=False, more=False, cap=131072):
    return {
        "required": required,
        "outcome": "empty" if count == 0 else "excluded" if admitted == 0 else
                   "complete" if admitted == count else "partial",
        "candidate_limit": limit, "candidate_count": count,
        "has_more_candidates": more, "admitted_count": admitted,
        "excluded_count": count - admitted, "max_rendered_bytes": cap,
    }


def diagnostics(manifest, reason, count):
    report = manifest["diagnostics"]
    assert report["excluded_count"] == count
    assert report["reason_counts"] == {reason: count}
    return report


@pytest.mark.parametrize("kind", NOTE_SOURCES)
async def test_every_note_source_rejects_raw_oversize_before_fetch_and_keeps_later_note(budget_case, kind):
    case = budget_case
    rejected, retained = await case.seed([
        note_for_source(kind, content="oversize-" + "é" * 70),
        note_for_source(kind, content="later-é🧭"),
    ])
    limits = {"max_note_body_bytes": 64}
    await case.configure([source(kind)], **limits)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:1000]
    assert_guarded(observed, [retained])
    payload = response.json()
    block = expected_block(retained, kind)
    assert payload["context"] == {"Contexté47": block}
    manifest = assert_manifest(payload, limits, fetched=utf8(retained["content"]), rendered=utf8(block))
    selected = manifest["sources"][0]
    assert selected["admission"] == admission(count=2, admitted=1)
    assert selected["coverage"] == ("record_traced" if kind == "card_notes" else "source_only")
    assert [record["note_id"] for record in selected["records"]] == (
        [retained["id"]] if kind == "card_notes" else []
    )
    report = diagnostics(manifest, "raw_body_limit", 1)
    assert report["truncated"] is False
    assert report["entries"] == [{
        "source_index": 0, "candidate_index": 0, "note_id": rejected["id"],
        "title": rejected["title"], "kind": rejected["kind"],
        "raw_body_bytes": utf8(rejected["content"]), "rendered_bytes": None,
        "revision_sha256": None, "reason": "raw_body_limit",
    }]


@pytest.mark.parametrize("kind", NOTE_SOURCES)
async def test_legacy_note_source_preserves_existing_format_and_manifest(budget_case, kind):
    case = budget_case
    notes = await case.seed([note_for_source(kind, content="Legacy é🧭 body")])
    await case.configure([source(kind)], enforced=False)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:1000]
    payload = response.json()
    assert payload["context"] == {"Contexté47": expected_block(notes[0], kind)}
    assert payload["context_manifest"]["schema_version"] == 1
    assert "budget" not in payload["context_manifest"]
    # Positive control: the observer sees the legacy path's actual body transfer.
    assert observed.body_reads[notes[0]["id"]] >= 1
    assert notes[0]["id"] in observed.orm_loads


async def test_stored_sixteen_megabyte_body_never_crosses_guarded_note_query(budget_case):
    case = budget_case
    await case.seed([{"content": "oversized-stored-note:" + "x" * (16 * 1024 * 1024)}])
    await case.configure([source()])
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:200]
    assert_guarded(observed, [])
    payload = response.json()
    assert payload["context"] == {"Contexté47": ""}
    manifest = assert_manifest(payload, fetched=0, rendered=0)
    diagnostics(manifest, "raw_body_limit", 1)


@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_raw_body_limit_counts_exact_utf8_bytes(budget_case, delta):
    case = budget_case
    note, = await case.seed([{"content": "é🧭e\u0301\r\nX"}])
    limit = utf8(note["content"]) + delta
    await case.configure([source()], max_note_body_bytes=limit)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert_guarded(observed, [] if delta < 0 else [note])
    payload = response.json()
    # Plain-text rendering may normalize CRLF; raw-byte accounting may not.
    manifest = assert_manifest(
        payload, {"max_note_body_bytes": limit},
        fetched=0 if delta < 0 else utf8(note["content"]),
        rendered=utf8(payload["context"]["Contexté47"]),
    )
    assert bool(payload["context"]["Contexté47"]) is (delta >= 0)
    assert manifest["sources"][0]["admission"] == admission(count=1, admitted=int(delta >= 0))


@pytest.mark.parametrize("delta", [-1, 0, 1])
@pytest.mark.parametrize("kind", NOTE_SOURCES)
async def test_optional_record_limit_admits_a_whole_unicode_block_or_nothing(budget_case, delta, kind):
    case = budget_case
    note, = await case.seed([note_for_source(kind, title="Évidence 🧭", content="complete é\nsecond line")])
    block = expected_block(note, kind)
    limit = utf8(block) + delta
    await case.configure([source(kind)], max_optional_note_bytes=limit)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert_guarded(observed, [note])
    payload = response.json()
    expected = "" if delta < 0 else block
    assert payload["context"] == {"Contexté47": expected}
    manifest = assert_manifest(payload, {"max_optional_note_bytes": limit},
                               fetched=utf8(note["content"]), rendered=utf8(expected))
    if delta < 0:
        entry, = diagnostics(manifest, "record_too_large", 1)["entries"]
        assert entry["revision_sha256"] == note_revision(note)
        assert entry["rendered_bytes"] == utf8(block)


@pytest.mark.parametrize("scope", ["source", "managed"])
@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_admission_counts_internal_separators_at_exact_source_and_managed_limits(budget_case, scope, delta):
    case = budget_case
    notes = await case.seed([{"content": "first é"}, {"content": "second 🧭"}])
    blocks = [expected_block(note) for note in notes]
    complete = "\n\n".join(blocks)
    limit = utf8(complete) + delta
    limits = {"max_optional_note_bytes": max(map(utf8, blocks))}
    selected = source()
    if scope == "source":
        selected["max_rendered_bytes"] = limit
    else:
        limits["max_managed_context_bytes"] = limit
    await case.configure([selected], **limits)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert_guarded(observed, notes)
    payload = response.json()
    expected = blocks[0] if delta < 0 else complete
    assert payload["context"] == {"Contexté47": expected}
    manifest = assert_manifest(payload, limits, fetched=sum(utf8(n["content"]) for n in notes), rendered=utf8(expected))
    assert manifest["sources"][0]["admission"] == admission(count=2, admitted=1 if delta < 0 else 2, cap=limit)
    if delta < 0:
        diagnostics(manifest, "source_budget" if scope == "source" else "total_budget", 1)


async def test_render_rejection_does_not_refund_fetch_budget_and_later_small_note_still_fits(budget_case):
    case = budget_case
    first, skipped, last = await case.seed([
        {"content": "a" * 60}, {"content": "b" * 40}, {"content": "last-é"},
    ])
    limits = {"max_note_body_bytes": 64, "max_note_fetch_bytes": 80, "max_optional_note_bytes": 64}
    await case.configure([source()], **limits)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert_guarded(observed, [first, last])
    payload = response.json()
    expected = expected_block(last)
    assert payload["context"] == {"Contexté47": expected}
    manifest = assert_manifest(payload, limits, fetched=60 + utf8(last["content"]), rendered=utf8(expected))
    report = manifest["diagnostics"]
    assert report["reason_counts"] == {"record_too_large": 1, "fetch_budget": 1}
    assert [entry["note_id"] for entry in report["entries"]] == [first["id"], skipped["id"]]
    assert report["entries"][1]["revision_sha256"] is None


async def test_repeated_source_aliases_reuse_one_body_fetch_but_charge_each_rendered_occurrence(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "unique-é🧭"}])
    aliases = ["Evidenceα", "Contextβ", "Repeatγ"]
    limits = {"max_note_body_bytes": utf8(note["content"]), "max_note_fetch_bytes": utf8(note["content"])}
    await case.configure([source(alias=alias) for alias in aliases], **limits)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert_guarded(observed, [note])
    payload = response.json()
    block = expected_block(note)
    assert payload["context"] == dict.fromkeys(aliases, block)
    manifest = assert_manifest(payload, limits,
                               fetched=utf8(note["content"]), rendered=3 * utf8(block))
    assert [item["alias"] for item in manifest["sources"]] == aliases
    assert [item["source_index"] for item in manifest["sources"]] == [0, 1, 2]
    assert all(item["records"][0]["note_id"] == note["id"] for item in manifest["sources"])


async def test_required_source_reserves_capacity_before_earlier_optional_alias(budget_case):
    case = budget_case
    optional, required = await case.seed([
        {"content": "o" * 50, "kind": "optional_kind"},
        {"content": "required-é", "kind": "required_kind"},
    ])
    optional_block = expected_block(optional, kind_filter=True)
    required_block = expected_block(required, kind_filter=True)
    cap = max(utf8(optional_block), utf8(required_block))
    limits = {"max_optional_note_bytes": cap, "max_managed_context_bytes": cap}
    await case.configure([
        source(alias="FirstOptional", filter={"kind": "optional_kind"}),
        source(alias="LaterRequired", filter={"kind": "required_kind"}, required=True),
    ], **limits)
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    payload = response.json()
    assert payload["context"] == {"FirstOptional": "", "LaterRequired": required_block}
    manifest = assert_manifest(payload, limits, fetched=sum(utf8(n["content"]) for n in [optional, required]),
                               rendered=utf8(required_block))
    assert [item["alias"] for item in manifest["sources"]] == ["FirstOptional", "LaterRequired"]
    assert manifest["sources"][1]["admission"] == admission(count=1, admitted=1, required=True, cap=cap)
    diagnostics(manifest, "total_budget", 1)


async def test_required_raw_rejection_returns_bounded_metadata_without_successful_receipt(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "PRIVATE_REQUIRED_BODY_" + "é" * 60}])
    await case.configure([source(required=True)], max_note_body_bytes=32)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 409, response.text[:500]
    assert_guarded(observed, [])
    payload = response.json()
    assert payload["error_code"] == "context_budget_exceeded"
    assert note["content"] not in response.text
    assert "PRIVATE_REQUIRED_BODY_" not in response.text
    report = payload["context"]
    assert "context" not in report
    assert report["budget"]["raw_note_bytes_fetched"] == 0
    assert report["sources"][0]["admission"] == admission(count=1, admitted=0, required=True)
    diagnostics(report, "raw_body_limit", 1)
    history = await case.receipt.http.get(
        case.receipt.execution_path(case.execution["id"]) + "/context-receipts",
        headers=case.receipt.headers["recipient"],
    )
    assert history.status_code == 200
    assert history.json() == []
    assert history.headers["X-Total-Count"] == "0"


@pytest.mark.parametrize("kind", NOTE_SOURCES[1:])
@pytest.mark.parametrize("limit", [2, 50])
async def test_formerly_unbounded_note_source_uses_window_plus_metadata_only_sentinel(budget_case, kind, limit):
    case = budget_case
    # These IDs sort first but are ineligible; filtering must precede the window.
    ineligible = note_for_source(kind, number=0, content="ineligible-private")
    if kind == "review_history":
        ineligible["kind"] = "other_kind"
    else:
        ineligible["pinned"] = False
    await case.seed([ineligible])
    notes = await case.seed([
        note_for_source(kind, number=index, content=f"eligible-{index}-é")
        for index in range(1, limit + 6)
    ])
    sentinel = notes[limit]
    sentinel["content"] = "sentinel-private:" + "s" * 2097152
    async with case.receipt.factory() as session:
        await session.execute(update(Note).where(Note.id == uuid.UUID(sentinel["id"])).values(content=sentinel["content"]))
        await session.commit()
    await case.configure([source(kind, **({"filter": {"limit": limit}} if limit != 50 else {}))])
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:300]
    assert_guarded(observed, notes[:limit])
    assert observed.header_ids == {note["id"] for note in notes[:limit + 1]}
    assert observed.header_row_count == limit + 1
    payload = response.json()
    expected = "\n\n".join(expected_block(note, kind) for note in notes[:limit])
    assert payload["context"] == {"Contexté47": expected}
    manifest = assert_manifest(payload, fetched=sum(utf8(note["content"]) for note in notes[:limit]), rendered=utf8(expected))
    assert manifest["sources"][0]["admission"] == admission(count=limit, admitted=limit, limit=limit, more=True)
    assert manifest["sources"][0]["records"] == []
    assert manifest["diagnostics"]["excluded_count"] == 0


@pytest.mark.parametrize("long_titles", [False, True])
async def test_diagnostics_bound_whole_entries_and_utf8_bytes_but_keep_full_window_counts(budget_case, long_titles):
    case = budget_case
    await case.seed([
        {"number": index, "title": "🧭" * 500 if long_titles else f"Evidence {index}",
         "content": f"reject-{index}-" + "x" * 80}
        for index in range(1, 51)
    ])
    await case.configure([source(alias="First"), source(alias="Repeat")], max_note_body_bytes=64)
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:300]
    assert_guarded(observed, [])
    manifest = assert_manifest(response.json(), {"max_note_body_bytes": 64}, fetched=0, rendered=0)
    report = diagnostics(manifest, "raw_body_limit", 100)
    assert report["truncated"] is True
    assert 0 < len(report["entries"]) <= 64
    assert utf8(compact_json(report)) <= 65536
    if long_titles:
        assert len(report["entries"]) < 64
    else:
        assert len(report["entries"]) == 64
    coordinates = [(entry["source_index"], entry["candidate_index"]) for entry in report["entries"]]
    assert coordinates == sorted(coordinates)
    for entry in report["entries"]:
        assert entry["title"] == ("🧭" * 500 if long_titles else f"Evidence {entry['candidate_index'] + 1}")
        assert entry["revision_sha256"] is None
        assert entry["rendered_bytes"] is None


async def test_same_size_body_edit_with_same_timestamp_changes_actual_fetched_revision(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "before-é"}])
    await case.configure([source()])
    first = await case.refresh()
    assert first.status_code == 200
    before = first.json()
    changed = {**note, "content": "after!-é"}
    assert utf8(note["content"]) == utf8(changed["content"])
    async with case.receipt.factory() as session:
        await session.execute(update(Note).where(Note.id == uuid.UUID(note["id"])).values(
            content=changed["content"], updated_at=note["updated_at"],
        ))
        await session.commit()
    second = await case.refresh()
    assert second.status_code == 200
    after = second.json()
    assert before["context_revision"] != after["context_revision"]
    assert after["context"] == {"Contexté47": expected_block(changed)}
    assert after["context_manifest"]["sources"][0]["records"][0]["revision_sha256"] == note_revision(changed)
    assert_manifest(after, fetched=utf8(changed["content"]), rendered=utf8(expected_block(changed)))


async def test_budget_opt_in_keeps_historical_v1_receipt_unchanged(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "historical-é"}])
    await case.configure([source()], enforced=False)
    original = await case.refresh()
    assert original.status_code == 200
    legacy = original.json()
    prepared = await case.receipt.prepare(case.execution, legacy, prompt=legacy["context"]["Contexté47"])
    assert prepared.status_code == 201, prepared.text
    receipt_id = prepared.json()["id"]
    first = await case.receipt.receipt(case.execution, receipt_id)
    assert first.status_code == 200
    preserved = copy.deepcopy(first.json())
    assert preserved["context_manifest"]["schema_version"] == 1
    await case.configure([source()])
    current = await case.refresh()
    assert current.status_code == 200
    assert_manifest(current.json(), fetched=utf8(note["content"]), rendered=utf8(expected_block(note)))
    historical = await case.receipt.receipt(case.execution, receipt_id)
    assert historical.status_code == 200
    assert historical.json() == preserved
    assert "budget" not in historical.json()["context_manifest"]


async def test_effective_policy_changes_context_revision_even_with_identical_admitted_output(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "unchanged-policy-evidence"}])
    await case.configure([source()])
    before = await case.refresh()
    assert before.status_code == 200
    await case.configure([source()], max_note_body_bytes=1024)
    after = await case.refresh()
    assert after.status_code == 200
    assert before.json()["context"] == after.json()["context"]
    assert before.json()["context_revision"] != after.json()["context_revision"]
    assert_manifest(after.json(), {"max_note_body_bytes": 1024}, fetched=utf8(note["content"]),
                    rendered=utf8(expected_block(note)))


async def test_required_whole_note_is_not_subject_to_optional_record_cap(budget_case):
    case = budget_case
    note, = await case.seed([{"content": "required-whole-content-é🧭"}])
    block = expected_block(note)
    await case.configure([source(required=True)], max_optional_note_bytes=16)
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": block}
    manifest = assert_manifest(response.json(), {"max_optional_note_bytes": 16},
                               fetched=utf8(note["content"]), rendered=utf8(block))
    assert manifest["sources"][0]["admission"] == admission(count=1, admitted=1, required=True)


@pytest.mark.parametrize("delta", [-1, 0, 1])
async def test_cumulative_fetch_limit_counts_utf8_without_fetching_one_byte_over(budget_case, delta):
    case = budget_case
    notes = await case.seed([{"content": "first-é🧭"}, {"content": "second-e\u0301🧭"}])
    limit = sum(utf8(note["content"]) for note in notes) + delta
    limits = {
        "max_note_body_bytes": max(utf8(note["content"]) for note in notes),
        "max_note_fetch_bytes": limit,
    }
    await case.configure([source()], **limits)
    expected_notes = notes[:1] if delta < 0 else notes
    with observe_notes(case) as observed:
        response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert_guarded(observed, expected_notes)
    payload = response.json()
    block = "\n\n".join(expected_block(note) for note in expected_notes)
    assert payload["context"] == {"Contexté47": block}
    manifest = assert_manifest(payload, limits, fetched=sum(utf8(note["content"]) for note in expected_notes),
                               rendered=utf8(block))
    if delta < 0:
        entry, = diagnostics(manifest, "fetch_budget", 1)["entries"]
        assert entry["note_id"] == notes[1]["id"]
        assert entry["revision_sha256"] is None
        assert entry["rendered_bytes"] is None
