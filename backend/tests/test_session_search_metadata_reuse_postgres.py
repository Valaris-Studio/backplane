# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Request-local metadata reuse must preserve the unchanged late read's answers.

Run serially on a disposable migrated PostgreSQL database. The SQL-shape case
is a causal reuse regression; these small fixtures are not latency evidence.
"""

import asyncio
import json
import uuid
from contextlib import asynccontextmanager, nullcontext
from dataclasses import astuple
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, event, select, text, update

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.schemas.session_search import SessionSearchRequest
from app.services.session_search import SessionSearchService
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import (
    paused_object_indexing as pause_processor_fixture,
    search,
)
from tests.test_session_search_latency_postgres import plan_nodes
from tests.test_session_search_postgres import pg_inline, receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
BODY = b"reuse needle body"
ISOLATIONS = ("READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE")


async def seeded(pg):
    path, session_id, acknowledgements = await pg_inline(pg, [BODY] * 4)
    return path, session_id, [uuid.UUID(ack["content_id"]) for ack in acknowledgements]


def between_scan_and_coverage(monkeypatch, action):
    original = SessionSearchService._recheck_objects

    async def recheck_after_action(self, hits):
        await action(self)
        return await original(self, hits)

    monkeypatch.setattr(SessionSearchService, "_recheck_objects", recheck_after_action)


@asynccontextmanager
async def search_transaction(pg, isolation):
    async with pg["factory"]() as db:
        transaction = await db.begin()
        try:
            await db.execute(text(f"SET TRANSACTION ISOLATION LEVEL {isolation}"))
            await db.execute(text("SET LOCAL statement_timeout='8s'"))
            await db.execute(text("SET LOCAL lock_timeout='2s'"))
            yield db
        finally:
            if transaction.is_active:
                await transaction.rollback()


async def transaction_certificate(db):
    return dict(
        (
            await db.execute(
                text(
                    "SELECT pg_current_snapshot()::text AS snapshot, "
                    "pg_current_xact_id_if_assigned()::text AS xid"
                )
            )
        )
        .mappings()
        .one()
    )


async def owner_search(pg, db, session_id):
    return await SessionSearchService(db).search(
        pg["workspace_id"],
        pg["owner_id"],
        session_id,
        SessionSearchRequest(q="reuse needle", limit=20),
    )


@pytest.mark.parametrize("unverified", [False, True])
async def test_unchanged_owner_request_uses_one_early_facts_statement_and_late_certificate(
    pg, monkeypatch, tmp_path, unverified
):
    path, _, contents = await seeded(pg)
    if unverified:
        async with pg["factory"].begin() as db:
            await db.execute(
                update(Content)
                .where(Content.id.in_(contents[:2]))
                .values(inline_text="REUSE NEEDLE BODY")
            )
    statements = []
    phase = "early"
    engine = pg["factory"].kw["bind"]
    original_scan = SessionSearchService._scan

    async def scan_then_late(self, *args, **kwargs):
        nonlocal phase
        phase = "scan"
        try:
            return await original_scan(self, *args, **kwargs)
        finally:
            phase = "late"

    def capture(_connection, _cursor, sql, parameters, _context, _many):
        if sql.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append({"phase": phase, "sql": sql, "parameters": parameters})

    monkeypatch.setattr(SessionSearchService, "_scan", scan_then_late)
    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        page = await search(pg["client"], path, "reuse needle")
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
        receipt_path(
            tmp_path, f"metadata-reuse-request-sql-{unverified}.json"
        ).write_text(json.dumps(statements, indent=2, default=str) + "\n")
    assert len(page["items"]) == 4
    assert page["eligible_bytes"] == 4 * len(BODY)
    indexed_count = 2 if unverified else 4
    assert page["coverage"]["indexed"] == {
        "count": indexed_count,
        "bytes": indexed_count * len(BODY),
    }
    metadata_aggregates = [
        statement
        for statement in statements
        if statement["phase"] != "scan"
        and "session_search_sources" in statement["sql"].lower()
        and "agent_session_contents" in statement["sql"].lower()
        and "sum(" in statement["sql"].lower()
        and not (
            statement["phase"] == "late"
            and "pg_current_snapshot()" in statement["sql"].lower()
        )
    ]
    assert len(metadata_aggregates) == 1, (
        "The unchanged owner request validated the content population again: "
        f"{[(row['phase'], row['sql']) for row in metadata_aggregates]}"
    )
    facts = metadata_aggregates[0]
    assert facts["phase"] == "early"
    for fragment in (
        "group by",
        "folded_bytes",
        "chunk_count",
        "pg_current_snapshot()",
        "public.session_search_leader_xid_if_assigned()",
    ):
        assert fragment in facts["sql"].lower(), fragment
    certificates = [
        statement
        for statement in statements
        if "pg_current_snapshot()" in statement["sql"].lower()
    ]
    assert [statement["phase"] for statement in certificates] == ["early", "late"]
    assert certificates[0] is facts
    early_sql, late_sql = [statement["sql"].lower() for statement in certificates]
    leader_getter = "public.session_search_leader_xid_if_assigned()"
    core_getter = "pg_current_xact_id_if_assigned()"
    assert early_sql.count(leader_getter) == 1 and core_getter not in early_sql
    assert late_sql.count(core_getter) == 1 and leader_getter not in late_sql
    assert all(sql.count("pg_current_snapshot()") == 1 for sql in (early_sql, late_sql))
    if unverified:
        assert "agent_session_contents" in certificates[1]["sql"].lower()
        assert "session_search_sources" in certificates[1]["sql"].lower()
    async with pg["factory"]() as db:
        await db.execute(text("SET TRANSACTION READ ONLY"))
        connection = await db.connection()
        raw = (
            await connection.exec_driver_sql(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + facts["sql"],
                facts["parameters"],
            )
        ).scalar_one()
    plan = json.loads(raw) if isinstance(raw, str) else raw
    receipt_path(tmp_path, f"metadata-reuse-facts-plan-{unverified}.json").write_text(
        json.dumps(plan, indent=2, default=str) + "\n"
    )
    # The SERIALIZABLE baseline may remain in SQL, but must not read chunks on
    # this content-only READ COMMITTED request. This replay is not latency proof.
    chunk_visits = sum(
        (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
        * node["Actual Loops"]
        for node in plan_nodes(plan[0]["Plan"])
        if node.get("Relation Name") == "session_search_chunks"
    )
    assert chunk_visits == 0, plan


async def test_concurrent_commit_between_snapshot_and_coverage_is_reported(
    pg, monkeypatch
):
    path, _, contents = await seeded(pg)

    async def other_transaction_commits(_service):
        async with pg["factory"].begin() as other:
            await other.execute(
                update(Source)
                .where(Source.content_id == contents[0])
                .values(status="pending")
            )

    between_scan_and_coverage(monkeypatch, other_transaction_commits)
    page = await search(pg["client"], path, "reuse needle")
    assert len(page["items"]) == 4
    assert page["coverage"]["indexed"] == {"count": 3, "bytes": 3 * len(BODY)}
    assert page["coverage"]["pending_index"] == {"count": 1, "bytes": len(BODY)}
    assert page["coverage"]["index_ready"] is False


async def test_concurrent_deletion_between_snapshot_and_coverage_is_reported(
    pg, monkeypatch
):
    path, _, contents = await seeded(pg)

    async def other_transaction_deletes(_service):
        async with pg["factory"].begin() as other:
            await other.execute(delete(Content).where(Content.id == contents[1]))

    between_scan_and_coverage(monkeypatch, other_transaction_deletes)
    page = await search(pg["client"], path, "reuse needle")
    assert len(page["items"]) == 3
    assert page["coverage"]["indexed"] == {"count": 3, "bytes": 3 * len(BODY)}
    assert page["coverage"]["available"] == {"count": 3, "bytes": 3 * len(BODY)}


@pytest.mark.parametrize("isolation", ISOLATIONS[:2])
async def test_own_later_write_between_snapshot_and_coverage_is_reported(
    pg, monkeypatch, isolation
):
    _, session_id, contents = await seeded(pg)
    certificates = []

    async def own_transaction_writes(service):
        certificates.append(await transaction_certificate(service.index.db))
        await service.index.db.execute(
            update(Source)
            .where(Source.content_id == contents[2])
            .values(status="unavailable", reason="object_missing")
        )
        certificates.append(await transaction_certificate(service.index.db))

    between_scan_and_coverage(monkeypatch, own_transaction_writes)
    async with search_transaction(pg, isolation) as db:
        page = await owner_search(pg, db, session_id)
    assert certificates[0]["xid"] is None
    assert certificates[1]["xid"] is not None
    assert page.coverage.indexed.count == 3
    assert page.coverage.unavailable.count == 1
    assert page.coverage.unavailable.bytes == len(BODY)


@pytest.mark.parametrize("isolation", ISOLATIONS)
async def test_own_earlier_write_is_reported_under_every_isolation(pg, isolation):
    _, session_id, contents = await seeded(pg)
    async with search_transaction(pg, isolation) as db:
        await db.execute(
            update(Source)
            .where(Source.content_id == contents[3])
            .values(status="pending")
        )
        page = await owner_search(pg, db, session_id)
    assert page.coverage.indexed.count == 3
    assert page.coverage.pending_index.count == 1
    assert page.eligible_bytes == 3 * len(BODY)


@pytest.mark.parametrize("isolation", ISOLATIONS)
async def test_own_earlier_and_later_writes_with_the_same_xid_are_reported(
    pg, monkeypatch, isolation
):
    _, session_id, contents = await seeded(pg)
    certificates = []

    async def own_later_write(service):
        await service.index.db.execute(
            update(Source)
            .where(Source.content_id == contents[2])
            .values(status="unavailable", reason="object_missing")
        )
        certificates.append(await transaction_certificate(service.index.db))

    between_scan_and_coverage(monkeypatch, own_later_write)
    async with search_transaction(pg, isolation) as db:
        await db.execute(
            update(Source)
            .where(Source.content_id == contents[3])
            .values(status="pending")
        )
        certificates.append(await transaction_certificate(db))
        page = await owner_search(pg, db, session_id)
    assert certificates[0]["xid"] is not None
    assert certificates[0]["xid"] == certificates[1]["xid"]
    if isolation != "READ COMMITTED":
        assert certificates[0] == certificates[1]
    assert page.coverage.indexed.count == 2
    assert page.coverage.pending_index.count == 1
    assert page.coverage.unavailable.count == 1
    assert page.coverage.unavailable.bytes == len(BODY)
    assert page.eligible_bytes == 3 * len(BODY)


@pytest.mark.parametrize("isolation", ISOLATIONS[:2])
async def test_own_savepoint_rollback_between_snapshot_and_coverage_is_reported(
    pg, monkeypatch, isolation
):
    _, session_id, contents = await seeded(pg)
    certificates = []
    async with search_transaction(pg, isolation) as db:
        savepoint = await db.begin_nested()
        await db.execute(
            update(Source)
            .where(Source.content_id == contents[0])
            .values(status="pending")
        )
        certificates.append(await transaction_certificate(db))

        async def roll_back_earlier_write(service):
            await savepoint.rollback()
            certificates.append(await transaction_certificate(service.index.db))

        between_scan_and_coverage(monkeypatch, roll_back_earlier_write)
        page = await owner_search(pg, db, session_id)
    assert certificates[0]["xid"] is not None
    assert certificates[0]["xid"] == certificates[1]["xid"]
    assert page.eligible_bytes == 3 * len(BODY)
    assert page.coverage.indexed.count == 4
    assert page.coverage.pending_index.count == 0
    assert page.coverage.index_ready is True


@pytest.mark.parametrize("isolation", ISOLATIONS[:2])
@pytest.mark.parametrize("release_savepoint", [False, True])
async def test_own_later_savepoint_outcome_is_reported(
    pg, monkeypatch, isolation, release_savepoint
):
    _, session_id, contents = await seeded(pg)
    certificates = []

    async def settle_later_savepoint(service):
        savepoint = await service.index.db.begin_nested()
        await service.index.db.execute(
            update(Source)
            .where(Source.content_id == contents[2])
            .values(status="unavailable", reason="object_missing")
        )
        if release_savepoint:
            await savepoint.commit()
        else:
            await savepoint.rollback()
        certificates.append(await transaction_certificate(service.index.db))

    between_scan_and_coverage(monkeypatch, settle_later_savepoint)
    async with search_transaction(pg, isolation) as db:
        await db.execute(
            update(Source)
            .where(Source.content_id == contents[3])
            .values(status="pending")
        )
        certificates.append(await transaction_certificate(db))
        page = await owner_search(pg, db, session_id)
    assert certificates[0]["xid"] is not None
    assert certificates[0]["xid"] == certificates[1]["xid"]
    assert page.eligible_bytes == 3 * len(BODY)
    assert page.coverage.indexed.count == (2 if release_savepoint else 3)
    assert page.coverage.unavailable.count == (1 if release_savepoint else 0)
    assert page.coverage.pending_index.count == 1


@pytest.mark.parametrize("unknown_size", [None, "unverified", "verified"])
async def test_unverified_bodies_are_reclassified_like_the_late_statement(
    pg, unknown_size
):
    path, session_id, contents = await seeded(pg)
    # The digest column still matches; the bytes do not, despite folding alike.
    async with pg["factory"].begin() as db:
        await db.execute(
            update(Content)
            .where(Content.id.in_(contents[:2]))
            .values(inline_text="REUSE NEEDLE BODY")
        )
        if unknown_size is not None:
            unknown_content = contents[0 if unknown_size == "unverified" else 2]
            await db.execute(
                update(Content)
                .where(Content.id == unknown_content)
                .values(byte_count=None, original_byte_count=None)
            )
    page = await search(pg["client"], path, "reuse needle")
    unavailable = [
        item for item in page["items"] if item["source_state"] == "unavailable"
    ]
    indexed_bytes = None if unknown_size == "verified" else 2 * len(BODY)
    unavailable_bytes = None if unknown_size == "unverified" else 2 * len(BODY)
    assert len(unavailable) == 2
    assert page["coverage"]["indexed"] == {"count": 2, "bytes": indexed_bytes}
    assert page["coverage"]["unavailable"] == {"count": 2, "bytes": unavailable_bytes}
    assert page["coverage"]["available"] == {
        "count": 4,
        "bytes": None if unknown_size else 4 * len(BODY),
    }
    assert page["coverage"]["eligible"] == {"count": 2, "bytes": indexed_bytes}
    async with pg["factory"]() as db:
        await db.execute(text("SET TRANSACTION READ ONLY"))
        service = SessionSearchService(db)
        session = await service._owned_session(
            pg["workspace_id"], pg["owner_id"], session_id
        )
        hits = [
            SimpleNamespace(
                available=False,
                chunk=SimpleNamespace(content_id=identity, event_id=None),
            )
            for identity in contents[:2]
        ]
        late = (await service._coverage(session, hits)).model_dump(mode="json")
    assert {
        name: value for name, value in page["coverage"].items() if name != "verified_at"
    } == {name: value for name, value in late.items() if name != "verified_at"}


async def test_a_later_request_does_not_reuse_the_previous_requests_facts(pg):
    path, _, contents = await seeded(pg)
    before = await search(pg["client"], path, "reuse needle")
    async with pg["factory"].begin() as db:
        await db.execute(
            update(Source)
            .where(Source.content_id == contents[0])
            .values(status="pending")
        )
    after = await search(pg["client"], path, "reuse needle")
    assert before["coverage"]["indexed"]["count"] == 4
    assert before["eligible_bytes"] == 4 * len(BODY)
    assert after["coverage"]["indexed"]["count"] == 3
    assert after["coverage"]["pending_index"]["count"] == 1
    assert after["eligible_bytes"] == 3 * len(BODY)


@pytest.mark.parametrize("autoflush", [True, False], ids=["autoflush", "no_autoflush"])
async def test_late_certificate_preserves_the_late_statements_orm_autoflush(
    pg, autoflush
):
    _, session_id, contents = await seeded(pg)
    engine = pg["factory"].kw["bind"]
    outcomes = []
    for implementation in ("baseline", "candidate"):
        async with search_transaction(pg, "READ COMMITTED") as db:
            repo = SessionSearchRepository(db)
            await repo.eligible_totals(session_id, SearchScope(EXTRACTOR_VERSION))
            source = await db.scalar(
                select(Source).where(Source.content_id == contents[0])
            )
            assert source is not None and source.status == "indexed"
            source.status = "pending"
            statements = []

            def capture(_connection, _cursor, sql, _parameters, _context, _many):
                statements.append(sql)

            event.listen(engine.sync_engine, "before_cursor_execute", capture)
            try:
                with nullcontext() if autoflush else db.no_autoflush:
                    if implementation == "baseline":
                        rows = [
                            tuple(row)
                            for row in await db.execute(
                                repo._content_coverage_query(
                                    session_id, EXTRACTOR_VERSION, set()
                                )
                            )
                        ]
                    else:
                        rows = [
                            astuple(row)
                            for row in await repo.content_coverage(
                                session_id, EXTRACTOR_VERSION, set()
                            )
                        ]
            finally:
                event.remove(engine.sync_engine, "before_cursor_execute", capture)
            updates = [sql for sql in statements if sql.lstrip().startswith("UPDATE")]
            assert len(updates) == int(autoflush), (implementation, statements)
            assert (source in db.dirty) is not autoflush
            assert db.in_transaction()
            assert sum(row[5] for row in rows if row[3] == "indexed") == (
                3 if autoflush else 4
            )
            assert sum(row[5] for row in rows if row[3] == "pending") == int(autoflush)
            if implementation == "candidate":
                fallback = [
                    sql
                    for sql in statements
                    if "sum(" in sql.lower()
                    and "agent_session_contents" in sql
                    and "session_search_sources" in sql
                ]
                assert len(fallback) == int(autoflush), statements
            outcomes.append(sorted(rows, key=repr))
    assert outcomes[0] == outcomes[1]


def capture_coverage_fallback(monkeypatch, repo):
    calls = []
    original = repo._content_coverage_query

    def late_query(*args, **kwargs):
        calls.append((args, kwargs))
        return original(*args, **kwargs)

    monkeypatch.setattr(repo, "_content_coverage_query", late_query)
    return calls


async def test_same_repository_does_not_reuse_facts_across_transactions(
    pg, monkeypatch
):
    _, session_id, _ = await seeded(pg)
    async with pg["factory"]() as db:
        repo = SessionSearchRepository(db)
        fallback = capture_coverage_fallback(monkeypatch, repo)
        async with db.begin():
            await repo.eligible_totals(session_id, SearchScope(EXTRACTOR_VERSION))
        async with db.begin():
            rows = await repo.content_coverage(session_id, EXTRACTOR_VERSION, set())
        assert len(fallback) == 1
        assert sum(row.count for row in rows if row.index_status == "indexed") == 4


@pytest.mark.parametrize("release_savepoint", [False, True])
async def test_read_only_savepoint_boundary_invalidates_coverage_reuse(
    pg, monkeypatch, release_savepoint
):
    _, session_id, _ = await seeded(pg)
    async with search_transaction(pg, "REPEATABLE READ") as db:
        repo = SessionSearchRepository(db)
        fallback = capture_coverage_fallback(monkeypatch, repo)
        savepoint = await db.begin_nested()
        await repo.eligible_totals(session_id, SearchScope(EXTRACTOR_VERSION))
        before = await transaction_certificate(db)
        if release_savepoint:
            await savepoint.commit()
        else:
            await savepoint.rollback()
        after = await transaction_certificate(db)
        assert before == after
        assert before["xid"] is None
        rows = await repo.content_coverage(session_id, EXTRACTOR_VERSION, set())
        # A rolled-back savepoint releases locks even when its snapshot and
        # unassigned xid stay equal. Reuse must retain savepoint provenance too.
        assert len(fallback) == 1
        assert sum(row.count for row in rows if row.index_status == "indexed") == 4


@pytest.mark.parametrize("mismatch", ["session", "extractor"])
async def test_same_repository_falls_back_for_different_coverage_identity(
    pg, monkeypatch, mismatch
):
    _, session_id, _ = await seeded(pg)
    _, other_session_id, _ = await pg_inline(pg, [BODY], native="reuse-other-session")
    async with search_transaction(pg, "READ COMMITTED") as db:
        repo = SessionSearchRepository(db)
        fallback = capture_coverage_fallback(monkeypatch, repo)
        await repo.eligible_totals(session_id, SearchScope(EXTRACTOR_VERSION))
        rows = await repo.content_coverage(
            other_session_id if mismatch == "session" else session_id,
            "previous-extractor" if mismatch == "extractor" else EXTRACTOR_VERSION,
            set(),
        )
        assert len(fallback) == 1
        if mismatch == "session":
            assert sum(row.count for row in rows) == 1
            assert all(row.index_status == "indexed" for row in rows)
        else:
            assert sum(row.count for row in rows) == 4
            assert all(row.index_status is None for row in rows)


async def test_repeatable_read_concurrent_commit_retains_transaction_visible_coverage(
    pg, monkeypatch
):
    _, session_id, contents = await seeded(pg)
    certificates = []

    async def other_transaction_commits(service):
        certificates.append(await transaction_certificate(service.index.db))
        async with pg["factory"].begin() as other:
            await other.execute(
                update(Source)
                .where(Source.content_id == contents[0])
                .values(status="pending")
            )
        certificates.append(await transaction_certificate(service.index.db))

    between_scan_and_coverage(monkeypatch, other_transaction_commits)
    async with search_transaction(pg, "REPEATABLE READ") as db:
        page = await owner_search(pg, db, session_id)
    assert certificates[0] == certificates[1]
    assert certificates[0]["xid"] is None
    assert len(page.items) == 4
    assert page.eligible_bytes == 4 * len(BODY)
    assert page.coverage.indexed.count == 4
    assert page.coverage.pending_index.count == 0
    async with pg["factory"]() as db:
        assert (
            await db.scalar(
                select(Source.status).where(Source.content_id == contents[0])
            )
            == "pending"
        )


async def test_raw_rollback_preserving_python_provenance_rejects_early_facts(
    pg, monkeypatch, tmp_path
):
    _, session_id, contents = await seeded(pg)
    factory = pg["factory"]
    receipt = {"status": "started", "fixture_contents": len(contents)}
    try:
        async with asyncio.timeout(20):
            async with factory() as anchor, factory() as db:
                await anchor.begin()
                await db.begin()
                try:
                    for session in (anchor, db):
                        await session.execute(
                            text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                        )
                        await session.execute(text("SET LOCAL statement_timeout='8s'"))
                        await session.execute(text("SET LOCAL lock_timeout='2s'"))

                    anchor_xid = await anchor.scalar(
                        text("SELECT pg_current_xact_id()::text")
                    )
                    await db.execute(
                        update(Source)
                        .where(Source.content_id == contents[0])
                        .values(status="pending")
                    )
                    writer_xid = await db.scalar(
                        text("SELECT pg_current_xact_id_if_assigned()::text")
                    )

                    # Keep xmin older than the writer and xmax beyond it. The
                    # writer's xid is excluded from its own snapshot's xip.
                    async with factory.begin() as later:
                        later_xid = await later.scalar(
                            text("SELECT pg_current_xact_id()::text")
                        )
                    assert int(anchor_xid) < int(writer_xid) < int(later_xid)
                    receipt["ordered_xids"] = [anchor_xid, writer_xid, later_xid]

                    repo = SessionSearchRepository(db)
                    fallback = capture_coverage_fallback(monkeypatch, repo)
                    totals = await repo.eligible_totals(
                        session_id, SearchScope(EXTRACTOR_VERSION)
                    )
                    assert totals == (3, 3 * len(BODY))
                    before = await transaction_certificate(db)
                    receipt["before"] = before
                    assert before["xid"] == writer_xid
                    reuse = repo._coverage_reuse
                    assert reuse is not None
                    assert reuse.facts.snapshot == before["snapshot"]
                    assert (
                        sum(
                            row.count
                            for row in reuse.facts.coverage_rows
                            if row.index_status == "indexed"
                        )
                        == 3
                    )

                    outer = db.sync_session.get_transaction()
                    nested = db.sync_session.get_nested_transaction()
                    connection = await db.connection()
                    raw = await connection.get_raw_connection()
                    driver = raw.driver_connection

                    # Deliberately bypass Session and Connection bookkeeping.
                    # Python provenance alone does not certify database transaction identity.
                    await driver.execute("ROLLBACK")
                    await driver.execute("BEGIN ISOLATION LEVEL READ COMMITTED")
                    await driver.execute("SET LOCAL statement_timeout='8s'")
                    await driver.execute("SET LOCAL lock_timeout='2s'")

                    provenance = {
                        "same_session_transaction": (
                            db.sync_session.get_transaction() is outer
                        ),
                        "same_nested_transaction": (
                            db.sync_session.get_nested_transaction() is nested
                        ),
                        "same_async_connection": (await db.connection() is connection),
                    }
                    receipt["provenance"] = provenance
                    assert all(provenance.values())
                    after = await transaction_certificate(db)
                    receipt["after"] = after
                    assert after["xid"] is None
                    assert after["snapshot"] == before["snapshot"], (
                        "Schedule precondition failed; preserve this first sample "
                        "and classify it, without retries or weakened assertions"
                    )

                    rows = await repo.content_coverage(
                        session_id, EXTRACTOR_VERSION, set()
                    )
                    receipt["fallback_calls"] = len(fallback)
                    receipt["indexed_contents"] = sum(
                        row.count for row in rows if row.index_status == "indexed"
                    )
                    assert receipt["indexed_contents"] == 4
                    assert len(fallback) == 1
                    assert repo._coverage_reuse is None
                    receipt["status"] = "passed"
                finally:
                    # The adapter still owns its original transaction object;
                    # its rollback command also closes the raw replacement.
                    try:
                        await db.rollback()
                    finally:
                        await anchor.rollback()
    finally:
        receipt_path(tmp_path, "early-xid-raw-rollback-provenance.json").write_text(
            json.dumps(receipt, indent=2, default=str) + "\n"
        )
