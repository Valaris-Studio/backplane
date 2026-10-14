# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B1 structural guards through actual authorized A1 context refresh."""

import json
import uuid

import pytest
from sqlalchemy import update

from app.models.notes.note import Note
from tests.routers.agents.context_budgets_support import (
    DEFAULT_POLICY,
    _budget_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    compact_json,
    expected_block,
    observe_notes,
    source,
    utf8,
)
from tests.routers.agents.context_receipts_support import document, note_revision, sha256
from tests.routers.agents.context_structure_support import (
    VISIBLE,
    deep_stored_document,
    depth_document,
    node_document,
    observe_note_queries,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.slow, pytest.mark.timeout(30)]


def visible_block(note, text=VISIBLE):
    return expected_block({**note, "content": text})


@pytest.mark.parametrize("count", [32, 33])
async def test_source_ceiling_precedes_note_queries_without_truncating_aliases(budget_case, count):
    case = budget_case
    note, = await case.seed([{"content": "one scoped body"}])
    configured = [source(alias=f"ArbitraryAlias{index}") for index in range(count)]
    await case.configure(configured)
    with observe_note_queries(case.engine) as queries, observe_notes(case) as observed:
        response = await case.refresh()
    if count == 32:
        assert response.status_code == 200, response.text[:500]
        assert len(queries) > 0 and observed.body_reads[note["id"]] > 0
        assert response.json()["context"] == {
            item["as"]: expected_block(note) for item in configured
        }
        assert [row["alias"] for row in response.json()["context_manifest"]["sources"]] == [
            item["as"] for item in configured
        ]
    else:
        actual = {"status": response.status_code, "note_queries": len(queries),
                  "body_reads": sum(observed.body_reads.values()),
                  "header_rows": observed.header_row_count, "orm_loads": len(observed.orm_loads)}
        assert actual == {"status": 409, "note_queries": 0, "body_reads": 0,
                          "header_rows": 0, "orm_loads": 0}, actual
        assert response.json()["error_code"] == "context_source_limit_exceeded"
        assert response.json()["context"] == {"source_limit": 32, "source_count": 33}


@pytest.mark.parametrize("shape,boundary", [("depth", 127), ("depth", 128),
                                             ("nodes", 99999), ("nodes", 100000)])
async def test_valid_pm_at_structural_boundary_keeps_exact_revision_and_render(budget_case, shape, boundary):
    case = budget_case
    value = depth_document(boundary) if shape == "depth" else node_document(boundary)
    stored = compact_json(value)
    assert utf8(stored) < DEFAULT_POLICY["max_note_body_bytes"]
    note, = await case.seed([{"content": stored}])
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    block = visible_block(note)
    assert response.json()["context"] == {"Contexté47": block}
    traced = response.json()["context_manifest"]["sources"][0]
    record, = traced["records"]
    assert record["revision_sha256"] == note_revision(note)
    assert record["rendered_sha256"] == traced["rendered_sha256"] == sha256(block)
    assert record["rendered_bytes"] == traced["rendered_bytes"] == utf8(block)


@pytest.mark.parametrize("required", [False, True])
@pytest.mark.parametrize("shape", ["depth", "nodes", "far_depth", "malformed_far_depth", "legacy_array_depth"])
async def test_structural_excess_is_whole_record_failure_before_revision_and_render(
    budget_case, shape, required,
):
    case = budget_case
    stored = (compact_json(depth_document(129)) if shape == "depth" else
              compact_json(node_document(100001)) if shape == "nodes" else
              deep_stored_document(4096) if shape == "far_depth" else
              deep_stored_document(4096)[:-1] if shape == "malformed_far_depth" else
              '[' * 129 + '0' + ']' * 129)
    reason = "structure_node_limit" if shape == "nodes" else "structure_depth_limit"
    assert utf8(stored) < DEFAULT_POLICY["max_note_body_bytes"]
    rejected, later = await case.seed([{"content": stored}, {"content": "later small é🧭"}])
    await case.configure([source(required=required)])
    response = await case.refresh()
    assert response.status_code == (409 if required else 200), response.text[:500]
    if required:
        assert response.json()["error_code"] == "context_budget_exceeded"
        manifest = response.json()["context"]
        assert "context" not in manifest
    else:
        payload = response.json()
        assert payload["context"] == {"Contexté47": expected_block(later)}
        manifest = payload["context_manifest"]
        assert [record["note_id"] for record in manifest["sources"][0]["records"]] == [later["id"]]
    report = manifest["diagnostics"]
    assert report["reason_counts"] == {reason: 1}
    assert report["excluded_count"] == 1 and report["truncated"] is False
    entry, = report["entries"]
    assert entry == {
        "source_index": 0, "candidate_index": 0, "note_id": rejected["id"],
        "title": rejected["title"], "kind": rejected["kind"],
        "raw_body_bytes": utf8(stored), "rendered_bytes": None,
        "revision_sha256": None, "reason": reason,
    }
    assert stored not in response.text
    history = await case.receipt.http.get(
        case.receipt.execution_path(case.execution["id"]) + "/context-receipts",
        headers=case.receipt.headers["curator"],
    )
    assert history.status_code == 200 and history.json() == []


async def test_quoted_delimiters_and_unicode_escapes_do_not_change_structure_or_note_revision(budget_case):
    case = budget_case
    value = document(VISIBLE)
    value["attrs"] = {"quoted": '[{"not":"structure"}]' * 150 + '\\"' * 150}
    stored = compact_json(value)
    note, = await case.seed([{"content": stored}])
    await case.configure([source()])
    first = await case.refresh()
    assert first.status_code == 200
    alternate = json.dumps(value, ensure_ascii=True, indent=2)
    async with case.receipt.factory() as session:
        await session.execute(update(Note).where(Note.id == uuid.UUID(note["id"])).values(content=alternate))
        await session.commit()
    second = await case.refresh()
    assert second.status_code == 200
    assert first.json()["context"] == second.json()["context"] == {"Contexté47": visible_block(note)}
    for response in (first, second):
        record, = response.json()["context_manifest"]["sources"][0]["records"]
        assert record["revision_sha256"] == note_revision(note)
        assert record["rendered_sha256"] == sha256(visible_block(note))
        assert record["rendered_bytes"] == utf8(visible_block(note))


@pytest.mark.parametrize("stored,visible", [
    ('{"type":"doc", "content":[broken', '{"type":"doc", "content":[broken'),
    ('{"ordinary":"legacy é🧭"}', '{"ordinary":"legacy é🧭"}'),
    ('[' * 128 + '0' + ']' * 128, '[' * 128 + '0' + ']' * 128),
    ("legacy plain é🧭", "legacy plain é🧭"),
    ("<p>legacy HTML é🧭</p>", "legacy HTML é🧭"),
])
async def test_bounded_legacy_fallback_retains_exact_stored_revision(budget_case, stored, visible):
    case = budget_case
    note, = await case.seed([{"content": stored}])
    await case.configure([source()])
    response = await case.refresh()
    assert response.status_code == 200, response.text[:500]
    assert response.json()["context"] == {"Contexté47": visible_block(note, visible)}
    record, = response.json()["context_manifest"]["sources"][0]["records"]
    assert record["revision_sha256"] == note_revision(note)
