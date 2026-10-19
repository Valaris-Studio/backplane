# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01 real PostgreSQL qualification, run serially by the integration owner.

Requires a disposable database migrated to current head and
SESSION_CAPTURE_TEST_DATABASE_URL; set RICH_CAPTURE_REQUIRE_LEGS=1 so a missing
database fails rather than becoming a passing-looking skipped gate. Synthetic
fixtures are deleted by the existing rich-capture PostgreSQL fixture. They are
not evidence of deployed historical backfill.
"""

import hashlib
import json
import math
import os
import uuid
from pathlib import Path
from time import perf_counter

import pytest
from sqlalchemy import delete, event, func, select, text, update

from app.exceptions import ConflictError, ResourceNotFoundError
from app.models.agent_session import AgentSession, AgentSessionContent
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import declaration, upload
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_content_postgres import post_batch, session_record
from tests.test_session_search import (
    SCAN_BYTES,
    SNIPPET_BYTES,
    exact_match,
    index_types,
    paused_object_indexing as pause_processor_fixture,
    search,
    searchable_tables,
)

pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture


async def pg_inline(pg, bodies, *, native="search-pg"):
    result = await post_batch(
        pg,
        [
            session_record(
                pg,
                native,
                [declaration(body, order=i) for i, body in enumerate(bodies)],
            )
        ],
    )
    assert result["rejected"] == [], result
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.owner_id == pg["owner_id"],
                AgentSession.native_session_id == native,
            )
        )
    assert session_id is not None
    path = f"/api/workspaces/{pg['slug']}/sessions/{session_id}"
    control = await pg["client"].get(f"{path}/contents")
    assert control.status_code == 200
    assert len(control.json()["items"]) == len(bodies)
    return path, session_id, result["contents"]


async def pg_uploaded(pg, body, *, order=0, native="search-pg-object"):
    [ack] = (
        await post_batch(
            pg,
            [
                session_record(
                    pg, native, [declaration(body, delivery="upload", order=order)]
                )
            ],
        )
    )["contents"]
    assert ack["outcome"] == "upload_required", ack
    settled = await upload(pg["client"], {"headers": pg["headers"]}, ack, body)
    assert settled["state"] == "available", settled
    async with pg["factory"].begin() as db:
        content = await db.get(AgentSessionContent, uuid.UUID(ack["content_id"]))
        session_id = content.session_id
    return f"/api/workspaces/{pg['slug']}/sessions/{session_id}", ack["content_id"]


def receipt_path(tmp_path, name):
    directory = Path(os.environ.get("SESSION_SEARCH_MEASUREMENT_DIR", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    return directory / name


async def test_postgres_64mib_complete_scan_bounded_requests_and_real_plans(
    pg, monkeypatch, tmp_path
):
    """Two full accepted 32 MiB bodies, not preview-sized stand-ins.

    Record p95 on bounded scan requests, actual SQL/plans, byte counters and
    response sizes. The agreed initial target is <=300ms; a failure calls for
    an evidence-based scan-budget decision, never reduced semantic coverage.
    """
    writer, processor = index_types()
    ids, texts = [], {}
    for index in range(2):
        marker = f"END_OF_ACCEPTED_BODY_{index}"
        body = b"." * ((32 << 20) - len(marker)) + marker.encode()
        path, content_id = await pg_uploaded(pg, body, order=index)
        ids.append(content_id)
        texts[content_id] = body.decode()
        prepared = await processor(pg["factory"]).prepare_source(uuid.UUID(content_id))
        assert prepared is not None
        async with pg["factory"].begin() as db:
            await writer(db).index_prepared_source(prepared)

    engine = pg["factory"].kw["bind"]
    tables = searchable_tables()
    async with engine.begin() as connection:
        for table in tables:
            await connection.execute(text(f'ANALYZE "{table.name}"'))
        for table in (
            "agent_sessions",
            "agent_session_contents",
            "agent_session_events",
            "workspace_members",
        ):
            await connection.execute(text(f'ANALYZE "{table}"'))
        version = await connection.scalar(text("SELECT version()"))

    ranged_reads = []
    original_read = LocalContentStore.read

    def only_hit_ranges(store, key, offset=0, length=None):
        assert length is not None and 0 < length <= SNIPPET_BYTES
        ranged_reads.append((key, offset, length))
        return original_read(store, key, offset, length)

    def no_full_objects(*_args, **_kwargs):
        pytest.fail("Search read a full object after indexing")

    monkeypatch.setattr(LocalContentStore, "read", only_hit_ranges)
    monkeypatch.setattr(LocalContentStore, "iter_bytes", no_full_objects)
    statements, requests, latencies = [], [], []

    def record_sql(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", record_sql)
    try:
        for repetition in range(3):
            cursor, found, seen_cursors, scanned = None, [], set(), 0
            for page_number in range(32):
                before, before_reads = len(statements), len(ranged_reads)
                started = perf_counter()
                page = await search(
                    pg["client"], path, "END_OF_ACCEPTED_BODY", cursor=cursor
                )
                elapsed = (perf_counter() - started) * 1000
                latencies.append(elapsed)
                assert page["eligible_bytes"] == 64 << 20
                assert page["scanned_bytes"] <= SCAN_BYTES
                assert len(ranged_reads) - before_reads == len(page["items"])
                scanned += page["scanned_bytes"]
                for hit in page["items"]:
                    assert hit["content_id"] in ids
                    exact_match(hit, texts[hit["content_id"]], "END_OF_ACCEPTED_BODY")
                found.extend(page["items"])
                requests.append(
                    {
                        "repetition": repetition,
                        "page": page_number,
                        "elapsed_ms": elapsed,
                        "scanned_bytes": page["scanned_bytes"],
                        "eligible_bytes": page["eligible_bytes"],
                        "complete": page["complete"],
                        "hit_count": len(page["items"]),
                        "response_bytes": len(json.dumps(page).encode()),
                        "sql_count": len(statements) - before,
                    }
                )
                if page["complete"]:
                    break
                assert page["next_cursor"] not in seen_cursors
                seen_cursors.add(page["next_cursor"])
                cursor = page["next_cursor"]
            else:
                pytest.fail("64 MiB did not complete within 32 bounded requests")
            assert {hit["content_id"] for hit in found} == set(ids)
            assert len(found) == 2
            assert scanned == 64 << 20
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record_sql)

    plans, seen = [], set()
    async with engine.connect() as connection:
        for statement, parameters in statements:
            signature = (statement, repr(parameters))
            if signature in seen:
                continue
            seen.add(signature)
            plan = (
                await connection.exec_driver_sql(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement, parameters
                )
            ).scalar_one()
            plans.append(
                {
                    "sql": statement,
                    "parameters": repr(parameters),
                    "plan": json.loads(plan) if isinstance(plan, str) else plan,
                }
            )
    assert plans, "Measurements must include actual PostgreSQL reads"
    p95 = sorted(latencies)[math.ceil(len(latencies) * 0.95) - 1]
    receipt_path(tmp_path, "session-search-64mib.json").write_text(
        json.dumps(
            {
                "database": version,
                "retained_body_bytes": 64 << 20,
                "max_accepted_body_bytes": 32 << 20,
                "requests": requests,
                "p95_ms": p95,
                "plans": plans,
            },
            indent=2,
            default=str,
        )
    )
    assert p95 <= 300, f"Bounded-request p95={p95:.2f}ms; see physical receipt"


@pytest.mark.parametrize("settlement", ["commit", "rollback"])
async def test_postgres_generation_becomes_visible_only_with_index_transaction(
    pg, settlement
):
    path, session_id, acks = await pg_inline(pg, [b"match one", b"match two"])
    first = await search(pg["client"], path, "match", limit=1)
    assert first["next_cursor"]
    writer, _ = index_types()
    async with pg["factory"]() as writer_db:
        transaction = await writer_db.begin()
        writer_pid = await writer_db.scalar(text("SELECT pg_backend_pid()"))
        original = await writer_db.get(
            AgentSessionContent, uuid.UUID(acks[0]["content_id"])
        )
        values = {
            column.name: getattr(original, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        new_id, body = uuid.uuid4(), b"match newly committed"
        values.update(
            id=new_id,
            content_key=hashlib.sha256(new_id.bytes).hexdigest(),
            inline_text=body.decode(),
            byte_count=len(body),
            sha256=hashlib.sha256(body).hexdigest(),
            source_order=100,
        )
        writer_db.add(AgentSessionContent(**values))
        await writer_db.flush()
        await writer(writer_db).index_source("content", new_id)
        assert writer_db.in_transaction(), "The index writer must not commit its caller"
        async with pg["factory"].begin() as reader:
            reader_pid = await reader.scalar(text("SELECT pg_backend_pid()"))
            assert reader_pid != writer_pid
            assert (
                await reader.scalar(
                    select(AgentSessionContent.id).where(
                        AgentSessionContent.id == new_id
                    )
                )
                is None
            )
        # Real independent request sees the old committed generation and page.
        during = await search(
            pg["client"], path, "match", limit=1, cursor=first["next_cursor"]
        )
        assert during["generation"] == first["generation"]
        assert all(hit["source_id"] != str(new_id) for hit in during["items"])
        if settlement == "commit":
            await transaction.commit()
        else:
            await transaction.rollback()
    after = await pg["client"].post(
        f"{path}/search",
        json={"q": "match", "limit": 1, "cursor": first["next_cursor"]},
    )
    if settlement == "commit":
        assert after.status_code == 409, after.text
        assert after.json()["error_code"] == "session_search_stale"
        fresh = await search(pg["client"], path, "match")
        assert fresh["generation"] != first["generation"]
        assert {hit["source_id"] for hit in fresh["items"]} == {
            ack["content_id"] for ack in acks
        } | {str(new_id)}
    else:
        assert after.status_code == 200, after.text
        assert after.json()["generation"] == first["generation"]
        assert len((await search(pg["client"], path, "match"))["items"]) == 2


@pytest.mark.parametrize(
    "change", ["delete_session", "retract_content", "replace_digest"]
)
async def test_postgres_prepared_object_cannot_resurrect_changed_or_deleted_source(
    pg, change
):
    path, content_id = await pg_uploaded(pg, b"PREPARED_PRIVATE_MARKER" * 2000)
    pending = await search(pg["client"], path, "PREPARED_PRIVATE_MARKER")
    assert pending["coverage"]["pending_index"]["count"] == 1
    writer, processor = index_types()
    prepared = await processor(pg["factory"]).prepare_source(uuid.UUID(content_id))
    assert prepared is not None
    async with pg["factory"].begin() as concurrent:
        content = await concurrent.get(AgentSessionContent, uuid.UUID(content_id))
        if change == "delete_session":
            await concurrent.execute(
                delete(AgentSession).where(AgentSession.id == content.session_id)
            )
        elif change == "retract_content":
            await concurrent.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.id == content.id)
                .values(
                    state="recorded",
                    coverage="source_unavailable",
                    coverage_reason="source_replaced",
                    storage_key=None,
                    storage_backend=None,
                )
            )
        else:
            await concurrent.execute(
                update(AgentSessionContent)
                .where(AgentSessionContent.id == content.id)
                .values(sha256="b" * 64)
            )
    # The second connection committed before the stale prepared source writes.
    async with pg["factory"].begin() as db:
        try:
            await writer(db).index_prepared_source(prepared)
        except (ConflictError, ResourceNotFoundError):
            pass
        assert db.in_transaction()
    response = await pg["client"].post(
        f"{path}/search", json={"q": "PREPARED_PRIVATE_MARKER"}
    )
    if change == "delete_session":
        assert response.status_code == 404
        async with pg["factory"].begin() as db:
            for table in searchable_tables():
                assert await db.scalar(select(func.count()).select_from(table)) == 0
    else:
        assert response.status_code == 200, response.text
        assert all(
            hit["source_state"] == "unavailable" and hit["snippet"] is None
            for hit in response.json()["items"]
        )
        assert "PREPARED_PRIVATE_MARKER" not in response.text


async def test_postgres_index_object_read_holds_no_database_transaction(
    pg, monkeypatch
):
    path, content_id = await pg_uploaded(pg, b"outside database transaction " * 2000)
    assert (await search(pg["client"], path, "outside"))["coverage"]["pending_index"][
        "count"
    ] == 1
    writer, processor = index_types()
    engine = pg["factory"].kw["bind"]
    transactions, reads = set(), []

    def begin(connection):
        transactions.add(id(connection))

    def end(connection):
        transactions.discard(id(connection))

    original_read, original_iter = LocalContentStore.read, LocalContentStore.iter_bytes

    def read(store, key, offset=0, length=None):
        assert not transactions, "Full indexing read holds a database transaction"
        reads.append(key)
        return original_read(store, key, offset, length)

    def pieces(store, key):
        assert not transactions, "Full indexing read holds a database transaction"
        reads.append(key)
        for piece in original_iter(store, key):
            assert not transactions
            yield piece

    event.listen(engine.sync_engine, "begin", begin)
    event.listen(engine.sync_engine, "commit", end)
    event.listen(engine.sync_engine, "rollback", end)
    monkeypatch.setattr(LocalContentStore, "read", read)
    monkeypatch.setattr(LocalContentStore, "iter_bytes", pieces)
    try:
        prepared = await processor(pg["factory"]).prepare_source(uuid.UUID(content_id))
        assert reads
        assert not transactions
        async with pg["factory"].begin() as db:
            await writer(db).index_prepared_source(prepared)
            assert db.in_transaction()
    finally:
        event.remove(engine.sync_engine, "begin", begin)
        event.remove(engine.sync_engine, "commit", end)
        event.remove(engine.sync_engine, "rollback", end)
