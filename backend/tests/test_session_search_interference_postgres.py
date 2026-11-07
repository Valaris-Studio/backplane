# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from contextlib import contextmanager

import pytest
from sqlalchemy import event, select

from app.models.agent_session import AgentSession
from app.repositories import session_search as repository
from app.services.session_search_text import CHUNK_CHARS, fold
from tests.rich_capture import declaration
from tests.test_session_content_postgres import pg as capture_postgres_fixture
from tests.test_session_content_postgres import post_batch, session_record
from tests.test_session_search import (
    exact_match,
    index_types,
    paused_object_indexing as paused_object_indexing_fixture,
    search,
)
from tests.test_session_search_postgres import pg_uploaded

pg = capture_postgres_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


async def indexed_inline_sources(env, bodies):
    native_session = "matching-work-" + uuid.uuid4().hex
    response = await post_batch(
        env,
        [
            session_record(
                env,
                native_session,
                [declaration(body, order=order) for order, body in enumerate(bodies)],
            )
        ],
    )
    assert response["rejected"] == []
    assert len(response["contents"]) == len(bodies)
    async with env["factory"]() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.owner_id == env["owner_id"],
                AgentSession.native_session_id == native_session,
            )
        )
    return (
        f"/api/workspaces/{env['slug']}/sessions/{session_id}",
        [item["content_id"] for item in response["contents"]],
    )


@contextmanager
def matching_work(env, monkeypatch):
    counts = {"queries": 0, "returned_rows": 0, "decoded_rows": 0, "folded_bytes": 0}
    original_decode = repository.decode_case_map

    def decode(folded, case_map):
        counts["decoded_rows"] += 1
        counts["folded_bytes"] += len(folded.encode())
        return original_decode(folded, case_map)

    def statement(_conn, cursor, sql, _parameters, _context, _many):
        if "session_search_chunks.case_map" in sql and sql.lstrip().startswith(
            "SELECT"
        ):
            counts["queries"] += 1
            counts["returned_rows"] += max(cursor.rowcount, 0)

    engine = env["factory"].kw["bind"].sync_engine
    monkeypatch.setattr(repository, "decode_case_map", decode)
    event.listen(engine, "after_cursor_execute", statement)
    try:
        yield counts
    finally:
        event.remove(engine, "after_cursor_execute", statement)
        monkeypatch.setattr(repository, "decode_case_map", original_decode)


async def test_dense_page_materializes_only_matching_prefix(pg, monkeypatch, tmp_path):
    body = ("Needle Straße " + "x" * 8000).encode()
    path, _ = await indexed_inline_sources(pg, [body] * 64)
    with matching_work(pg, monkeypatch) as counts:
        page = await search(pg["client"], path, "needle", limit=20)
    (tmp_path / "matching-work.json").write_text(json.dumps(counts, indent=2))
    assert len(page["items"]) == 20
    assert page["next_cursor"] is not None
    for item in page["items"]:
        exact_match(item, body.decode(), "Needle")
    assert counts["returned_rows"] <= 21, counts
    assert counts["decoded_rows"] <= 21, counts
    assert counts["folded_bytes"] <= 21 * len(fold(body.decode()).encode()), counts


async def test_no_match_scans_full_window_with_one_matching_query(pg, monkeypatch):
    bodies = [b"ordinary " + b"x" * 8000] * 64
    path, _ = await indexed_inline_sources(pg, bodies)
    with matching_work(pg, monkeypatch) as counts:
        page = await search(pg["client"], path, "absent_literal", limit=20)
    assert page["items"] == []
    assert page["complete"] is True
    assert page["scanned_bytes"] == sum(len(body) for body in bodies)
    assert counts == {
        "queries": 1,
        "returned_rows": 0,
        "decoded_rows": 0,
        "folded_bytes": 0,
    }


async def test_sparse_late_matches_are_not_lost_to_matching_batch(pg, monkeypatch):
    bodies = [b"ordinary " + b"x" * 8000] * 60 + [b"late needle"] * 3
    path, content_ids = await indexed_inline_sources(pg, bodies)
    with matching_work(pg, monkeypatch) as counts:
        page = await search(pg["client"], path, "needle", limit=20)
    assert [item["content_id"] for item in page["items"]] == content_ids[-3:]
    assert page["complete"] is True
    assert page["scanned_bytes"] == sum(len(body) for body in bodies)
    assert counts["queries"] == 1
    assert counts["returned_rows"] == counts["decoded_rows"] == 3


async def test_matching_refill_preserves_overlap_unicode_and_resume(pg, monkeypatch):
    writer, processor = index_types()
    body = ("x" * CHUNK_CHARS + "Straße tail").encode()
    content_ids = []
    for order in range(31):
        path, content_id = await pg_uploaded(
            pg, body, order=order, native="matching-refill-overlap"
        )
        prepared = await processor(pg["factory"]).prepare_source(uuid.UUID(content_id))
        assert prepared is not None
        async with pg["factory"].begin() as db:
            await writer(db).index_prepared_source(prepared)
        content_ids.append(content_id)
    with matching_work(pg, monkeypatch) as counts:
        first = await search(pg["client"], path, "STRASSE", limit=20)
    assert len(first["items"]) == 20
    assert first["next_cursor"] is not None
    assert counts["queries"] <= 3
    second = await search(
        pg["client"], path, "STRASSE", limit=20, cursor=first["next_cursor"]
    )
    assert second["complete"] is True
    items = first["items"] + second["items"]
    assert [item["content_id"] for item in items] == content_ids
    assert len(items) == 31
    for item in items:
        exact_match(item, body.decode(), "Straße", start=CHUNK_CHARS)
    assert (
        first["scanned_bytes"] + second["scanned_bytes"]
        == len(fold(body.decode()).encode()) * 31
    )
