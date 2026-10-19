# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""A committed index change at cursor-prefix validation requires a restart."""

import asyncio
import base64
import json
from time import perf_counter

import pytest
from sqlalchemy import text

from app.repositories.session_search import SessionSearchRepository
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.storage.session_content import store_for
from tests.test_session_search import exact_match, search
from tests.test_session_search_lifecycle_review_postgres import (
    indexed_object,
    isolated_pg as isolated_pg,
    pg as pg,
    source_index_state,
)

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
PREFIX_BARRIER_SECONDS = 5
BODY = ("prefix🙂 needle first needle second tail" + "." * 20_000).encode()
QUERY = "needle"


async def test_committed_chunk_removal_at_resume_prefix_returns_stale_search(
    isolated_pg, monkeypatch
):
    env = isolated_pg
    assert env["factory"].kw["bind"].dialect.name == "postgresql"
    source = await indexed_object(env, BODY)
    first = await search(env["client"], source["path"], QUERY, limit=1)
    [first_hit] = first["items"]
    exact_match(first_hit, BODY.decode(), QUERY)
    cursor = first["next_cursor"]
    assert cursor is not None and len(cursor) <= 1024
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    second_byte = BODY.index(QUERY.encode(), BODY.index(QUERY.encode()) + len(QUERY))
    second_character = len(BODY[:second_byte].decode())
    assert decoded["c"] == second_character > 0
    assert decoded["y"] == second_byte > second_character

    control = await search(env["client"], source["path"], QUERY, cursor=cursor, limit=1)
    [second_hit] = control["items"]
    exact_match(second_hit, BODY.decode(), QUERY, start=second_byte)
    assert control["generation"] == first["generation"]
    assert control["scanned_bytes"] == len(BODY) - second_byte + 1
    assert control["complete"] is True and control["next_cursor"] is None
    before = await source_index_state(env["factory"], source)
    assert before[0] == first["generation"] and before[1:3] == ("indexed", 1)

    # Prepare the existing missing-object lifecycle, but do not change its
    # committed index until the continuation has passed its fingerprint check.
    store_for(source["backend"]).delete(source["key"])
    prepared = await SessionSearchObjectProcessor(env["factory"]).prepare_source(
        source["content_id"]
    )
    assert prepared.outcome == "missing_object"
    unchanged = await source_index_state(env["factory"], source)
    assert unchanged[:3] == before[:3]

    entered, released = asyncio.Event(), asyncio.Event()
    original_prefix = SessionSearchRepository.owned_folded_text
    observed = {}
    started = perf_counter()

    async def held_prefix(repository, chunk_id):
        observed["chunk_id"] = str(chunk_id)
        observed["reader_pid"] = await repository.db.scalar(text("SELECT pg_backend_pid()"))
        observed["entered_ms"] = (perf_counter() - started) * 1000
        entered.set()
        await released.wait()
        owned = await original_prefix(repository, chunk_id)
        observed["prefix_absent_after_commit"] = owned is None
        return owned

    with monkeypatch.context() as patch:
        patch.setattr(SessionSearchRepository, "owned_folded_text", held_prefix)
        request = asyncio.create_task(env["client"].post(
            f"{source['path']}/search",
            json={"q": QUERY, "cursor": cursor, "limit": 1},
        ))
        arrival = asyncio.create_task(entered.wait())
        try:
            await asyncio.wait(
                {request, arrival}, timeout=PREFIX_BARRIER_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not entered.is_set():
                if request.done():
                    response = request.result()
                    pytest.fail(f"No held prefix lookup: HTTP {response.status_code}: {response.text}")
                pytest.fail("Search did not reach its real cursor-prefix lookup")
            assert not request.done()
            async with env["factory"].begin() as writer_db:
                writer_pid = await writer_db.scalar(text("SELECT pg_backend_pid()"))
                assert writer_pid != observed["reader_pid"]
                outcome = await SessionSearchIndexWriter(writer_db).index_prepared_source(prepared)
                assert outcome == "unavailable"
                assert writer_db.in_transaction(), "The writer must not commit its caller"
            observed["writer_pid"] = writer_pid
            after = await source_index_state(env["factory"], source)
            assert after[0] > before[0]
            assert after[1:3] == ("unavailable", 0)
            observed["committed_ms"] = (perf_counter() - started) * 1000
        finally:
            released.set()
            arrival.cancel()
            await asyncio.gather(arrival, return_exceptions=True)
            if not request.done():
                await asyncio.wait_for(request, PREFIX_BARRIER_SECONDS)
        response = request.result()

    assert observed["prefix_absent_after_commit"] is True
    assert response.request.url.query == b""
    assert response.headers["cache-control"] == "private, no-store"
    receipt = {
        "valid_control_status": 200,
        "cursor_unchanged": True,
        "resume_chars": decoded["c"], "resume_bytes": decoded["y"],
        "generation_before": before[0], "generation_after": after[0],
        "source_after": after[1], "chunks_after": after[2],
        **observed,
        "finished_ms": (perf_counter() - started) * 1000,
        "response_status": response.status_code, "response": response.json(),
    }
    print("B01_PREFIX_RACE_RECEIPT " + json.dumps(receipt, sort_keys=True))
    assert response.status_code == 409, json.dumps(receipt, indent=2)
    assert response.json()["error_code"] == "session_search_stale"
    assert "items" not in response.json() and "coverage" not in response.json()
    assert QUERY not in response.text and cursor not in response.text
