# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Actual matching reads across overlap, resume and metadata-window boundaries."""

import json
import uuid
from contextlib import contextmanager

import pytest
from sqlalchemy import event, select

from app.models.agent_session import AgentSession
from app.models.session_search import SessionSearchChunk
from app.repositories import session_search as repository
from app.schemas.companion import MAX_INGEST_EVENT_BYTES
from app.services.session_search_text import CHUNK_CHARS, fold
from tests.test_agent_sessions import record as event_record
from tests.test_session_calls import prompt
from tests.test_session_content_postgres import pg as capture_postgres_fixture
from tests.test_session_content_postgres import post_batch
from tests.test_session_search import (
    exact_match,
    index_types,
    paused_object_indexing as paused_object_indexing_fixture,
    search,
)
from tests.test_session_search_postgres import pg_inline, pg_uploaded

pg = capture_postgres_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


@contextmanager
def matching_reads(env, monkeypatch):
    work = {"batches": [], "queries": 0, "returned_rows": 0}
    decoded = []
    original_decode = repository.decode_case_map
    original_matching = repository.SessionSearchRepository.matching_chunks

    def decode(folded, case_map):
        result = original_decode(folded, case_map)
        decoded.append(result)
        return result

    async def matching(repo, chunk_ids, query, limit):
        before = len(decoded)
        rows = await original_matching(repo, chunk_ids, query, limit)
        # Observe the real decoder results, including a body decoded but
        # discarded before returning. No SQL rows or matching decisions are stubbed.
        identities = {id(row.text): str(key) for key, row in rows.items()}
        work["batches"].append(
            {
                "requested": [str(key) for key in chunk_ids],
                "returned": [str(key) for key in rows],
                "decoded": [identities.get(id(row)) for row in decoded[before:]],
            }
        )
        return rows

    def statement(_conn, cursor, sql, _parameters, _context, _many):
        if "session_search_chunks.case_map" in sql and sql.lstrip().startswith(
            "SELECT"
        ):
            work["queries"] += 1
            work["returned_rows"] += max(cursor.rowcount, 0)

    engine = env["factory"].kw["bind"].sync_engine
    monkeypatch.setattr(repository, "decode_case_map", decode)
    monkeypatch.setattr(repository.SessionSearchRepository, "matching_chunks", matching)
    event.listen(engine, "after_cursor_execute", statement)
    try:
        yield work
    finally:
        event.remove(engine, "after_cursor_execute", statement)
        monkeypatch.setattr(repository, "decode_case_map", original_decode)
        monkeypatch.setattr(
            repository.SessionSearchRepository, "matching_chunks", original_matching
        )


def materialized_once(work, *, limit):
    returned = [key for batch in work["batches"] for key in batch["returned"]]
    assert len(returned) == len(set(returned)), work
    assert work["returned_rows"] == len(returned), work
    assert work["queries"] == len(work["batches"]), work
    for batch in work["batches"]:
        assert len(batch["returned"]) <= limit + 1, work
        assert len(batch["decoded"]) == len(batch["returned"]), work
        assert set(batch["decoded"]) == set(batch["returned"]), work
    return returned


async def test_many_hits_in_one_chunk_resume_without_duplicate_decodes(
    pg, monkeypatch, tmp_path
):
    unit, occurrences, limit = "Straße|", 73, 20
    body = unit * occurrences + " tail"
    path, _, acknowledgements = await pg_inline(
        pg, [body.encode()], native="matching-one-chunk-many-hits"
    )
    content_id = acknowledgements[0]["content_id"]
    pages, receipts, seen_cursors = [], [], set()
    cursor = None
    for _ in range(4):
        with matching_reads(pg, monkeypatch) as work:
            page = await search(
                pg["client"], path, "STRASSE", limit=limit, cursor=cursor
            )
        assert work["queries"] == 1, work
        assert len(materialized_once(work, limit=limit)) == 1
        assert page["eligible_bytes"] == len(fold(body).encode())
        pages.append(page)
        receipts.append(work)
        if page["complete"]:
            break
        assert page["next_cursor"] not in seen_cursors
        seen_cursors.add(page["next_cursor"])
        cursor = page["next_cursor"]
    assert [len(page["items"]) for page in pages] == [20, 20, 20, 13]
    assert pages[-1]["complete"] is True
    items = [item for page in pages for item in page["items"]]
    for ordinal, item in enumerate(items):
        assert item["content_id"] == content_id
        exact_match(item, body, "Straße", start=ordinal * len(unit.encode()))
    assert [page["scanned_bytes"] for page in pages] == [
        20 * len(fold(unit).encode()),
        20 * len(fold(unit).encode()),
        20 * len(fold(unit).encode()),
        len(fold(unit * 13 + " tail").encode()),
    ]
    # The same body must be read again on another page that resumes inside it.
    assert len({work["batches"][0]["returned"][0] for work in receipts}) == 1
    (tmp_path / "matching-one-chunk-reads.json").write_text(
        json.dumps(receipts, indent=2)
    )


@pytest.mark.parametrize("first_hit_start", [CHUNK_CHARS - 1, CHUNK_CHARS])
async def test_overlap_only_candidates_do_not_add_matching_round_trips(
    pg, monkeypatch, tmp_path, first_hit_start
):
    pairs = 8
    # A start on the last owned character is still a hit even when the
    # substring ends in the overlap. A start one character later is owned
    # only by the next chunk. Both are ordinary writer-generated chunks.
    first_pair = (
        "x" * first_hit_start + "needle" + "x" * (2 * CHUNK_CHARS - first_hit_start - 6)
    )
    following_pair = "x" * CHUNK_CHARS + "needle" + "x" * (CHUNK_CHARS - 6)
    body = first_pair + following_pair * (pairs - 1)
    path, content_id = await pg_uploaded(
        pg, body.encode(), native="matching-overlap-ids"
    )
    writer, processor = index_types()
    prepared = await processor(pg["factory"]).prepare_source(uuid.UUID(content_id))
    assert prepared is not None
    async with pg["factory"].begin() as db:
        await writer(db).index_prepared_source(prepared)

    pages, receipts, seen_cursors = [], [], set()
    cursor = None
    for ordinal in range(pairs):
        with matching_reads(pg, monkeypatch) as work:
            page = await search(pg["client"], path, "needle", limit=1, cursor=cursor)
        if ordinal == 0:
            (tmp_path / "matching-overlap-first-page.json").write_text(
                json.dumps(work, indent=2)
            )
        assert work["queries"] == 1, work
        returned = materialized_once(work, limit=1)
        assert len(returned) <= 2, work
        [item] = page["items"]
        assert item["content_id"] == content_id
        expected_start = (
            first_hit_start if ordinal == 0 else (2 * ordinal + 1) * CHUNK_CHARS
        )
        exact_match(item, body, "needle", start=expected_start)
        assert page["eligible_bytes"] == len(body.encode())
        assert page["complete"] is (ordinal == pairs - 1)
        if not page["complete"]:
            assert page["next_cursor"] not in seen_cursors
            seen_cursors.add(page["next_cursor"])
        pages.append(page)
        receipts.append(work)
        cursor = page["next_cursor"]
    assert [page["scanned_bytes"] for page in pages] == [
        3 * CHUNK_CHARS,
        *([2 * CHUNK_CHARS] * (pairs - 2)),
        CHUNK_CHARS,
    ]
    assert sum(page["scanned_bytes"] for page in pages) == len(body.encode())
    assert (
        len(
            {
                key
                for work in receipts
                for batch in work["batches"]
                for key in batch["returned"]
            }
        )
        == pairs
    )
    (tmp_path / "matching-overlap-reads.json").write_text(
        json.dumps(receipts, indent=2)
    )


async def test_matching_scan_stops_at_metadata_window_before_late_hit(
    pg, monkeypatch, tmp_path
):
    # Small independent event leaves exercise the actual 2,048-chunk boundary
    # without changing the configured limit or constructing a huge body.
    leaves = ["ordinary"] * 2048 + ["needle"]
    native = "matching-metadata-window"
    raw = prompt(1, json.dumps(leaves))
    capture = event_record([raw], str(pg["mapping_id"]), session=native)
    assert len(json.dumps(capture["events"][0]).encode()) <= MAX_INGEST_EVENT_BYTES
    result = await post_batch(pg, [capture])
    assert result["rejected"] == [], result
    async with pg["factory"]() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.owner_id == pg["owner_id"],
                AgentSession.native_session_id == native,
            )
        )
        chunk_ids = list(
            await db.scalars(
                select(SessionSearchChunk.id)
                .where(SessionSearchChunk.session_id == session_id)
                .order_by(SessionSearchChunk.ordinal)
            )
        )
    assert len(chunk_ids) == 2049
    path = f"/api/workspaces/{pg['slug']}/sessions/{session_id}"
    with matching_reads(pg, monkeypatch) as first_work:
        first = await search(pg["client"], path, "needle", limit=20)
    assert first["items"] == []
    assert first["complete"] is False
    assert first["scanned_bytes"] == 2048 * len("ordinary")
    assert first_work["queries"] == 1
    assert materialized_once(first_work, limit=20) == []
    assert first_work["batches"][0]["requested"] == [
        str(key) for key in chunk_ids[:2048]
    ]
    with matching_reads(pg, monkeypatch) as second_work:
        second = await search(
            pg["client"], path, "needle", limit=20, cursor=first["next_cursor"]
        )
    assert second_work["queries"] == 1
    assert materialized_once(second_work, limit=20) == [str(chunk_ids[-1])]
    [item] = second["items"]
    assert item["source_kind"] == "event"
    assert item["event_id"] == raw["event"]["id"]
    assert item["field"] == "prompt.text.2048"
    exact_match(item, "needle", "needle")
    assert second["complete"] is True
    assert second["scanned_bytes"] == len("needle")
    expected_bytes = sum(len(leaf.encode()) for leaf in leaves)
    assert first["eligible_bytes"] == second["eligible_bytes"] == expected_bytes
    assert first["scanned_bytes"] + second["scanned_bytes"] == expected_bytes
    (tmp_path / "matching-window-reads.json").write_text(
        json.dumps([first_work, second_work], indent=2)
    )
