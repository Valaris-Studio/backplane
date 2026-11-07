# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Native PostgreSQL work bounds for hot-session search coverage.

The real owner route must report every retained source while pending index
bookkeeping does not inflate the coverage join. This is a physical-work
regression, independent of elapsed-time noise on a shared test host.
"""

import json
import os
import re
import uuid
from dataclasses import asdict, astuple
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, event, func, literal, select, text, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql.asyncpg import dialect as asyncpg_dialect
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.session_search import SessionSearchChunk, SessionSearchSource
from app.models.workspace import WorkspaceMember
from app.repositories.session_search import (
    ContentCoverageRow,
    SearchScope,
    SessionSearchRepository,
)
from tests.rejected_session_search_metadata import coverage_totals_query
from tests.session_search_rejected_eligibility import (
    _large_eligibility_totals,
    supports_eligibility_scope,
)
from app.services.session_search import SessionSearchService
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rich_capture import declaration, rich_record
from tests.test_session_calls import prompt
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_content_postgres import post_batch
from tests.test_session_search import (
    paused_object_indexing as pause_processor_fixture,
    search,
)
from tests.test_session_search_index_migration_postgres import (
    migration_database as index_migration_database_fixture,
)
from tests.test_session_search_postgres import pg_inline

pg = content_postgres_fixture
migration_database = index_migration_database_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


def plan_nodes(node):
    yield node
    for child in node.get("Plans", []):
        yield from plan_nodes(child)


async def seed_pending_contents(pg, session_id, template_id, count):
    columns = [column.name for column in AgentSessionContent.__table__.columns]
    prefix = uuid.uuid4().hex
    replacements = {
        "id": "md5(:prefix || g::text)::uuid",
        "content_key": "md5(:prefix || g::text) || md5(g::text || :prefix)",
        "source_order": "100 + g",
    }
    projection = ",".join(replacements.get(name, f'c."{name}"') for name in columns)
    names = ",".join(f'"{name}"' for name in columns)
    async with pg["factory"].begin() as db:
        await db.execute(
            text(
                f"INSERT INTO agent_session_contents ({names}) "
                f"SELECT {projection} FROM agent_session_contents c "
                "CROSS JOIN generate_series(1, :count) g WHERE c.id=:template"
            ),
            {"prefix": prefix, "count": count, "template": template_id},
        )
    # Publish the bulk growth before refreshing statistics: FK checks may
    # otherwise reuse a sequential plan cached for the tiny template table.
    async with pg["factory"].begin() as db:
        await db.execute(text("ANALYZE agent_session_contents"))
        await db.execute(
            text(
                "INSERT INTO session_search_sources "
                "(id,session_id,content_id,status,extractor_version,source_digest,"
                "byte_count,folded_bytes,chunk_count) "
                "SELECT md5('source:' || c.id::text)::uuid,c.session_id,c.id,"
                "'pending',:version,c.sha256,c.byte_count,0,0 "
                "FROM agent_session_contents c WHERE c.session_id=:session "
                "AND c.source_order>100"
            ),
            {"version": EXTRACTOR_VERSION, "session": session_id},
        )
        for table in (
            "agent_session_contents",
            "session_search_sources",
            "session_search_chunks",
            "agent_sessions",
        ):
            await db.execute(text(f'ANALYZE "{table}"'))


async def test_pending_metadata_does_not_enter_search_coverage_join(pg, tmp_path):
    bodies = [f"latency_needle {number}".encode() for number in range(21)]
    path, session_id, acknowledgements = await pg_inline(pg, bodies)
    count = 10_000
    await seed_pending_contents(
        pg, session_id, uuid.UUID(acknowledgements[0]["content_id"]), count
    )
    engine = pg["factory"].kw["bind"]
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        page = await search(pg["client"], path, "latency_needle", limit=20)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    assert len(page["items"]) == 20
    assert page["coverage"]["indexed"]["count"] == 21
    assert page["coverage"]["pending_index"] == {
        "count": count,
        "bytes": count * len(bodies[0]),
    }
    assert page["coverage"]["available"]["count"] == count + 21
    assert page["coverage"]["eligible"]["count"] == count + 21
    assert page["coverage"]["index_ready"] is False
    coverage_queries = [
        (sql, parameters)
        for sql, parameters in statements
        if "original_bytes" in sql and "session_search_sources" in sql
    ]
    assert len(coverage_queries) == 1, "Coverage remains one coherent statement"
    sql, parameters = coverage_queries[0]
    async with engine.connect() as connection:
        await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        await connection.exec_driver_sql("SET LOCAL statement_timeout='10s'")
        raw = (
            await connection.exec_driver_sql(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, parameters
            )
        ).scalar_one()
    plan = json.loads(raw) if isinstance(raw, str) else raw
    source_nodes = [
        node
        for node in plan_nodes(plan[0]["Plan"])
        if node.get("Relation Name") == "session_search_sources"
    ]
    assert source_nodes
    joined_sources = sum(
        node["Actual Rows"] * node["Actual Loops"] for node in source_nodes
    )
    receipt = {
        "pending_sources": count,
        "settled_sources": 21,
        "source_rows_entering_join": joined_sources,
        "sql": sql,
        "parameters": parameters,
        "plan": plan,
        "page": page,
    }
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "pending-coverage-join.json").write_text(
        json.dumps(receipt, indent=2, default=str) + "\n"
    )
    assert joined_sources <= 21, (
        f"Coverage joined {joined_sources} source rows for only 21 settled sources; "
        f"{count} pending rows have the same public coverage as absent index rows"
    )


@pytest.mark.parametrize("unverified", [False, True])
@pytest.mark.parametrize("population", [18, 2048, 2049])
async def test_coverage_preserves_current_status_and_unknown_sizes(
    pg, unverified, population
):
    path, session_id, acknowledgements = await pg_inline(pg, [b"seed"])
    # Each row names its public classification rather than deriving the
    # expectation from the repository's status/digest expressions.
    cases = [
        (
            "available",
            "captured",
            "text/plain",
            "indexed",
            "current",
            7,
            None,
            "indexed",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "pending",
            "current",
            11,
            None,
            "pending_index",
        ),
        (
            "available",
            "captured",
            "text/plain",
            None,
            "current",
            13,
            None,
            "pending_index",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "indexed",
            "old_extractor",
            17,
            None,
            "pending_index",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "indexed",
            "old_digest",
            19,
            None,
            "pending_index",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "unavailable",
            "current",
            23,
            None,
            "unavailable",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "not_text",
            "current",
            29,
            None,
            "nontext",
        ),
        (
            "available",
            "captured",
            "image/png",
            "indexed",
            "current",
            31,
            None,
            "nontext",
        ),
        (
            "pending",
            "captured",
            "text/plain",
            "pending",
            "current",
            37,
            None,
            "pending_upload",
        ),
        (
            "recorded",
            "withheld_by_policy",
            "text/plain",
            "pending",
            "current",
            41,
            43,
            "withheld",
        ),
        (
            "recorded",
            "expired",
            "text/plain",
            "indexed",
            "current",
            47,
            53,
            "uncaptured",
        ),
        (
            "recorded",
            "collection_failed",
            "text/plain",
            "pending",
            "current",
            None,
            None,
            "uncaptured",
        ),
        (
            "recorded",
            "metadata_only",
            "text/plain",
            "pending",
            "current",
            59,
            61,
            "unavailable",
        ),
        (
            "available",
            "truncated",
            "text/plain",
            "pending",
            "current",
            None,
            67,
            "pending_index",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "not_text",
            "old_digest",
            71,
            None,
            "pending_index",
        ),
        (
            "available",
            "captured",
            "text/plain",
            "unavailable",
            "old_extractor",
            73,
            None,
            "pending_index",
        ),
    ]
    cases.extend(
        [
            (
                "available",
                "captured",
                "text/plain",
                "indexed",
                "current",
                0,
                None,
                "indexed",
            ),
            (
                "available",
                "captured",
                "text/plain",
                "indexed",
                "null_digest",
                79,
                None,
                "pending_index",
            ),
        ]
    )
    assert len(cases) == 18
    expected = {
        name: {"count": 0, "bytes": 0}
        for name in (
            "indexed",
            "pending_index",
            "pending_upload",
            "withheld",
            "uncaptured",
            "unavailable",
            "nontext",
            "available",
            "eligible",
        )
    }

    def add(bucket, size):
        expected[bucket]["count"] += 1
        if size is None or expected[bucket]["bytes"] is None:
            expected[bucket]["bytes"] = None
        else:
            expected[bucket]["bytes"] += size

    ids = []
    async with pg["factory"].begin() as db:
        template = await db.get(
            AgentSessionContent, uuid.UUID(acknowledgements[0]["content_id"])
        )
        values = {
            column.name: getattr(template, column.name)
            for column in template.__table__.columns
        }
        await db.execute(
            delete(AgentSessionContent).where(AgentSessionContent.id == template.id)
        )
        for number, (
            state,
            coverage,
            media,
            status,
            identity,
            size,
            original,
            bucket,
        ) in enumerate(cases):
            content_id = uuid.uuid4()
            ids.append(content_id)
            db.add(
                AgentSessionContent(
                    **{
                        **values,
                        "id": content_id,
                        "content_key": content_id.hex * 2,
                        "source_order": number,
                        "state": state,
                        "coverage": coverage,
                        "media_type": media,
                        "byte_count": size,
                        "original_byte_count": original,
                        "sha256": None
                        if identity == "null_digest"
                        else values["sha256"],
                    }
                )
            )
            await db.flush()
            if status is not None:
                db.add(
                    SessionSearchSource(
                        id=uuid.uuid4(),
                        session_id=session_id,
                        content_id=content_id,
                        status=status,
                        source_digest="0" * 64
                        if identity == "old_digest"
                        else values["sha256"],
                        extractor_version="previous"
                        if identity == "old_extractor"
                        else EXTRACTOR_VERSION,
                        byte_count=size,
                        folded_bytes=0,
                        chunk_count=0,
                    )
                )
            if unverified and bucket == "indexed":
                bucket = "unavailable"
            amount = original if state == "recorded" and original is not None else size
            add(bucket, amount)
            if state == "available":
                add("available", size)
            if bucket in {"indexed", "pending_index"}:
                add("eligible", size)
        # Zero-byte upload metadata changes branch cardinality without adding
        # Source rows or hiding unknown bytes in the classified cases above.
        for number in range(len(cases), population):
            content_id = uuid.uuid4()
            ids.append(content_id)
            db.add(
                AgentSessionContent(
                    **{
                        **values,
                        "id": content_id,
                        "content_key": content_id.hex * 2,
                        "source_order": number,
                        "state": "pending",
                        "byte_count": 0,
                        "original_byte_count": None,
                    }
                )
            )
            add("pending_upload", 0)
    async with pg["factory"].begin() as db:
        service = SessionSearchService(db)
        session = await service._owned_session(
            pg["workspace_id"], pg["owner_id"], session_id
        )
        facts = await service.index.content_facts(
            session_id, SearchScope(EXTRACTOR_VERSION)
        )
        baseline_rows = await service.index.content_coverage(
            session_id, EXTRACTOR_VERSION, set()
        )

        def coverage_groups(rows):
            groups = {}
            for row in rows:
                assert isinstance(row, ContentCoverageRow)
                key = (
                    row.state,
                    row.coverage,
                    row.is_text,
                    row.index_status or "pending",
                    row.unverified,
                )
                totals = groups.setdefault(key, [0] * 5)
                for position, amount in enumerate(astuple(row)[5:]):
                    totals[position] += amount
            return groups

        assert coverage_groups(facts.coverage_rows) == coverage_groups(baseline_rows)
        assert facts.eligible_totals == (0, 0)
        hits = (
            [
                SimpleNamespace(
                    available=False,
                    chunk=SimpleNamespace(content_id=identity, event_id=None),
                )
                for identity in ids
            ]
            if unverified
            else []
        )
        result = (await service._coverage(session, hits)).model_dump()
    assert {name: result[name] for name in expected} == expected
    assert result["index_ready"] is False
    assert result["linked_child_metadata"] == {"count": 0, "searchable": False}
    # Deletion changes current coverage even though the search generation did
    # not change: this guards against substituting a generation-keyed cache.
    async with pg["factory"].begin() as db:
        await db.execute(
            delete(AgentSessionContent).where(
                AgentSessionContent.session_id == session_id
            )
        )
    after = await search(pg["client"], path, "seed")
    assert all(after["coverage"][name] == {"count": 0, "bytes": 0} for name in expected)
    assert after["coverage"]["index_ready"] is True


async def test_coverage_uses_content_session_and_fresh_owner_membership(pg):
    path, session_id, acknowledgements = await pg_inline(pg, [b"owner needle"])
    _, other_session_id, _ = await pg_inline(
        pg, [b"separate session " * 20], native="other-session"
    )
    # The declared session-identity invariant rejects reassignment without
    # changing the content or its owner's current access to coverage.
    async with pg["factory"].begin() as db:
        with pytest.raises(IntegrityError):
            async with db.begin_nested():
                await db.execute(
                    update(SessionSearchSource)
                    .where(
                        SessionSearchSource.content_id
                        == uuid.UUID(acknowledgements[0]["content_id"])
                    )
                    .values(session_id=other_session_id)
                )
    page = await search(pg["client"], path, "needle")
    assert page["coverage"]["indexed"] == {"count": 1, "bytes": len(b"owner needle")}
    assert page["coverage"]["available"]["count"] == 1

    foreign = content_postgres_fixture.__wrapped__()
    foreign_env = await foreign.__anext__()
    try:
        response = await foreign_env["client"].post(
            path + "/search", json={"q": "needle"}
        )
        assert response.status_code in {403, 404}
        assert "owner needle" not in response.text
    finally:
        await foreign.aclose()

    async with pg["factory"].begin() as db:
        await db.execute(
            delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == pg["workspace_id"],
                WorkspaceMember.user_id == pg["owner_id"],
            )
        )
    response = await pg["client"].post(path + "/search", json={"q": "needle"})
    assert response.status_code in {403, 404}
    assert "owner needle" not in response.text


@pytest.fixture
async def dense_pg(migration_database, monkeypatch, tmp_path):
    # Whole-index sizes need fresh relations, independent of earlier CAP rows.
    await (await migration_database.cli("upgrade", "head")).finish()
    async with migration_database.engine.connect() as connection:
        await connection.execute(text("SET TRANSACTION READ ONLY"))
        await connection.execute(text("SET LOCAL statement_timeout='10s'"))
        identity = dict(
            (
                await connection.execute(
                    text(
                        "SELECT current_database() AS database, d.oid::bigint AS oid, "
                        "pg_get_userbyid(d.datdba) AS owner, current_user AS role, "
                        "current_setting('data_directory') AS data_directory, "
                        "current_setting('work_mem') AS work_mem, "
                        "(SELECT version_num FROM alembic_version) AS head "
                        "FROM pg_database d WHERE d.datname=current_database()"
                    )
                )
            )
            .mappings()
            .one()
        )
        assert identity["database"] == migration_database.name
        assert identity["owner"] == identity["role"]
        assert identity["head"] == "130"
        assert identity["work_mem"] == "64MB"
        for model in (AgentSessionContent, SessionSearchSource, SessionSearchChunk):
            assert await connection.scalar(select(func.count()).select_from(model)) == 0
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / "dense-fixture-before.json").open("x") as output:
        output.write(json.dumps(identity, indent=2) + "\n")
    with monkeypatch.context() as environment:
        environment.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", migration_database.url)
        fixture = content_postgres_fixture.__wrapped__()
        try:
            yield await fixture.__anext__()
        finally:
            await fixture.aclose()


@pytest.mark.timeout(90)
async def test_dense_totals_read_metadata_without_body_heap_or_spills(
    dense_pg, tmp_path
):
    pg = dense_pg
    body = (b"dense needle " + b"retained text " * 100)[:1024]
    _, session_id, acknowledgements = await pg_inline(pg, [body])
    count = 100_000
    content_id = uuid.UUID(acknowledgements[0]["content_id"])
    await seed_pending_contents(pg, session_id, content_id, count)
    async with pg["factory"].begin() as db:
        source = await db.scalar(
            select(SessionSearchSource).where(
                SessionSearchSource.content_id == content_id
            )
        )
        template = await db.scalar(
            select(SessionSearchChunk).where(SessionSearchChunk.source_id == source.id)
        )
        values = {
            column.name: getattr(template, column.name)
            for column in SessionSearchChunk.__table__.columns
        }
        columns = list(values)
        projection = []
        for name in columns:
            projection.append(
                {
                    "id": "md5('dense-chunk:' || s.id::text)::uuid",
                    "session_id": "s.session_id",
                    "source_id": "s.id",
                    "sort_order": "c.source_order",
                }.get(name, ":" + name)
            )
        await db.execute(
            text(
                "INSERT INTO session_search_chunks (" + ",".join(columns) + ") "
                "SELECT " + ",".join(projection) + " FROM session_search_sources s "
                "JOIN agent_session_contents c ON c.id=s.content_id "
                "WHERE c.session_id=:session AND s.status='pending'"
            ),
            {**values, "session": session_id},
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.session_id == session_id)
            .values(status="indexed", folded_bytes=len(body), chunk_count=1)
        )
    engine = pg["factory"].kw["bind"]
    # Mark committed pages all-visible so a covering metadata path can be
    # distinguished from fetching the wide body heap, independently of cache.
    async with engine.connect() as connection:
        connection = await connection.execution_options(isolation_level="AUTOCOMMIT")
        for table in (
            "session_search_chunks",
            "session_search_sources",
            "agent_session_contents",
        ):
            await connection.exec_driver_sql(
                f"VACUUM (ANALYZE, INDEX_CLEANUP ON) {table}"
            )
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        async with pg["factory"].begin() as db:
            await db.execute(text("SET TRANSACTION READ ONLY"))
            assert await db.scalar(text("SHOW work_mem")) == "64MB"
            service = SessionSearchService(db)
            await service._owned_session(pg["workspace_id"], pg["owner_id"], session_id)
            repo = SessionSearchRepository(db)
            statements.clear()
            assert await repo.eligible_totals(
                session_id, SearchScope(EXTRACTOR_VERSION)
            ) == (
                count + 1,
                (count + 1) * len(body),
            )
            measured_queries = {"eligible_totals": list(statements)}
            statements.clear()
            rows = await repo.content_coverage(session_id, EXTRACTOR_VERSION, set())
            measured_queries["content_coverage"] = list(statements)
            assert sum(row.count for row in rows) == count + 1
            assert sum(row.stored_bytes for row in rows) == (count + 1) * len(body)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    plans = {}
    async with engine.connect() as connection:
        await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        assert (
            await connection.exec_driver_sql("SHOW work_mem")
        ).scalar_one() == "64MB"
        for label, measured in measured_queries.items():
            assert len(measured) == 1, "Each aggregate observes one statement snapshot"
            sql, params = measured[0]
            raw = (
                await connection.exec_driver_sql(
                    "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, params
                )
            ).scalar_one()
            plan = json.loads(raw) if isinstance(raw, str) else raw
            plans[label] = {"sql": sql, "parameters": params, "plan": plan}
    chunk_paths = [
        node
        for node in plan_nodes(plans["eligible_totals"]["plan"][0]["Plan"])
        if node.get("Relation Name") == "session_search_chunks"
    ]
    heap_rows = sum(
        (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
        * node["Actual Loops"]
        for node in chunk_paths
        if node["Node Type"] != "Index Only Scan"
    )
    heap_fetches = sum(node.get("Heap Fetches", 0) for node in chunk_paths)
    metadata_indexes = {
        node["Index Name"]
        for node in plan_nodes(plans["eligible_totals"]["plan"][0]["Plan"])
        if node.get("Relation Name")
        in {"agent_session_contents", "session_search_sources"}
        and node["Node Type"] in {"Index Scan", "Index Only Scan"}
    }
    async with engine.connect() as connection:
        metadata_index_bytes = {
            name: (
                await connection.exec_driver_sql(
                    "SELECT pg_relation_size(to_regclass($1::text))", (name,)
                )
            ).scalar_one()
            for name in metadata_indexes
        }
    spills = {
        label: result["plan"][0]["Plan"].get("Temp Written Blocks", 0)
        for label, result in plans.items()
    }
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "dense-metadata-plans.json").write_text(
        json.dumps(
            {
                "source_count": count + 1,
                "body_bytes": len(body),
                "chunk_heap_rows": heap_rows,
                "chunk_heap_fetches": heap_fetches,
                "metadata_index_bytes": metadata_index_bytes,
                "temporary_blocks": spills,
                "plans": plans,
                "maximum_metadata_index_bytes": (count + 1) * 512,
            },
            indent=2,
            default=str,
        )
        + "\n"
    )
    # Index-only buffer hits include repeated visibility-map references, so
    # they cannot measure body-heap work. All-visible pages must need no heap
    # reads, and the selected indexes must remain smaller than body storage.
    assert heap_rows == 0, f"Eligibility visited {heap_rows} body-heap rows"
    assert heap_fetches == 0
    assert all(node["Actual Loops"] == 0 for node in chunk_paths), chunk_paths
    assert metadata_indexes
    assert sum(metadata_index_bytes.values()) <= (count + 1) * 512
    assert all(blocks == 0 for blocks in spills.values()), spills


async def original_eligible_totals(repo, session_id, scope):
    row = (
        await repo.db.execute(
            repo._scanned(
                (
                    func.count(func.distinct(SessionSearchChunk.source_id)),
                    func.coalesce(func.sum(SessionSearchChunk.owned_bytes), 0),
                ),
                session_id,
                scope,
            )
        )
    ).one()
    return int(row[0]), int(row[1])


async def assert_original_and_large_totals(repo, session_id, scope, expected):
    assert await original_eligible_totals(repo, session_id, scope) == expected
    assert await repo.eligible_totals(session_id, scope) == expected
    assert (
        tuple(
            (await repo.db.execute(_large_eligibility_totals(session_id, scope))).one()
        )
        == expected
    )


async def test_eligible_totals_follow_source_facts_and_content_scope(pg):
    _, session_id, acknowledgements = await pg_inline(
        pg, [b"first needle", b"second needle"]
    )
    _, other_session_id, _ = await pg_inline(
        pg, [b"other"], native="other-chunk-session"
    )
    first_id, second_id = [uuid.UUID(ack["content_id"]) for ack in acknowledgements]
    async with pg["factory"].begin() as db:
        first = await db.scalar(
            select(SessionSearchSource).where(
                SessionSearchSource.content_id == first_id
            )
        )
        second = await db.scalar(
            select(SessionSearchSource).where(
                SessionSearchSource.content_id == second_id
            )
        )
        chunk = await db.scalar(
            select(SessionSearchChunk).where(SessionSearchChunk.source_id == first.id)
        )
        first_source_id, second_source_id, first_chunk_id = (
            first.id,
            second.id,
            chunk.id,
        )
        values = {
            column.name: getattr(chunk, column.name)
            for column in SessionSearchChunk.__table__.columns
        }
        db.add(
            SessionSearchChunk(
                **{
                    **values,
                    "id": uuid.uuid4(),
                    "ordinal": 1,
                    "channel": "tool_output",
                    "folded_text": "xyz",
                    "owned_chars": 3,
                    "owned_bytes": 3,
                }
            )
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.id == first_source_id)
            .values(folded_bytes=15, chunk_count=2)
        )
        await db.flush()
        repo = SessionSearchRepository(db)
        assert await repo.eligible_totals(
            session_id, SearchScope(EXTRACTOR_VERSION)
        ) == (2, 28)
        scope = SearchScope(EXTRACTOR_VERSION)
        await assert_original_and_large_totals(repo, session_id, scope, (2, 28))
        typed = _large_eligibility_totals(session_id, scope).subquery()
        assert await db.scalar(select(func.pg_typeof(list(typed.c)[1]))) == "bigint"
        # Retained chunks and exact counters do not authorize counting a
        # source whose current index state or extractor became invalid.
        for changes in (
            {"status": "pending"},
            {"status": "unavailable"},
            {"status": "not_text"},
            {"extractor_version": "previous"},
        ):
            nested = await db.begin_nested()
            try:
                await db.execute(
                    update(SessionSearchSource)
                    .where(SessionSearchSource.id == first_source_id)
                    .values(**changes)
                )
                retained = await db.scalar(
                    select(func.count())
                    .select_from(SessionSearchChunk)
                    .where(SessionSearchChunk.source_id == first_source_id)
                )
                assert retained == 2
                await assert_original_and_large_totals(repo, session_id, scope, (1, 13))
            finally:
                await nested.rollback()
        await db.execute(
            delete(SessionSearchChunk).where(
                SessionSearchChunk.source_id == second_source_id
            )
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.id == second_source_id)
            .values(folded_bytes=0, chunk_count=0)
        )
        for model, identity in (
            (SessionSearchChunk, first_chunk_id),
            (SessionSearchSource, first_source_id),
            (AgentSessionContent, first_id),
        ):
            with pytest.raises(IntegrityError):
                async with db.begin_nested():
                    await db.execute(
                        update(model)
                        .where(model.id == identity)
                        .values(session_id=other_session_id)
                    )
        await db.execute(
            delete(SessionSearchChunk).where(SessionSearchChunk.id == first_chunk_id)
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.id == first_source_id)
            .values(folded_bytes=3, chunk_count=1)
        )
        await assert_original_and_large_totals(repo, session_id, scope, (1, 3))
        assert await repo.eligible_totals(
            session_id, SearchScope(EXTRACTOR_VERSION)
        ) == (1, 3)
        assert await repo.eligible_totals(
            session_id,
            SearchScope(EXTRACTOR_VERSION, channels=frozenset({"tool_output"})),
        ) == (1, 3)
        assert await repo.eligible_totals(
            session_id,
            SearchScope(EXTRACTOR_VERSION, channels=frozenset({"assistant"})),
        ) == (0, 0)
        db.add(
            SessionSearchChunk(
                **{
                    **values,
                    "id": uuid.uuid4(),
                    "source_id": second_source_id,
                    "channel": "assistant",
                    "folded_text": "",
                    "owned_chars": 0,
                    "owned_bytes": 0,
                }
            )
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.id == second_source_id)
            .values(folded_bytes=0, chunk_count=1)
        )
        await db.execute(
            update(AgentSessionContent)
            .where(AgentSessionContent.id == second_id)
            .values(channel="assistant")
        )
        await db.flush()
        assert await repo.eligible_totals(
            session_id, SearchScope(EXTRACTOR_VERSION)
        ) == (2, 3)
        await assert_original_and_large_totals(repo, session_id, scope, (2, 3))
        await assert_original_and_large_totals(
            repo,
            session_id,
            SearchScope(EXTRACTOR_VERSION, channels=frozenset({"assistant"})),
            (1, 0),
        )
        assert await repo.eligible_totals(
            session_id,
            SearchScope(EXTRACTOR_VERSION, channels=frozenset({"assistant"})),
        ) == (1, 0)
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.id == second_source_id)
            .values(call_anchor="zero-byte-call")
        )
        assert await repo.eligible_totals(
            session_id,
            SearchScope(
                EXTRACTOR_VERSION, failed_anchors=frozenset({"zero-byte-call"})
            ),
        ) == (1, 0)
        assert await repo.eligible_totals(
            session_id,
            SearchScope(EXTRACTOR_VERSION, work_anchors=frozenset({"absent-call"})),
        ) == (0, 0)


@pytest.mark.timeout(90)
async def test_tiny_totals_stay_bounded_after_hot_prepared_requests(pg, tmp_path):
    body = b"prepared totals needle " + b"x" * 1000
    _, hot_session, acknowledgements = await pg_inline(pg, [body], native="hot-plan")
    content_id = uuid.UUID(acknowledgements[0]["content_id"])
    hot_extra = 100_000
    await seed_pending_contents(pg, hot_session, content_id, hot_extra)
    async with pg["factory"].begin() as db:
        source = await db.scalar(
            select(SessionSearchSource).where(
                SessionSearchSource.content_id == content_id
            )
        )
        template = await db.scalar(
            select(SessionSearchChunk).where(SessionSearchChunk.source_id == source.id)
        )
        values = {
            column.name: getattr(template, column.name)
            for column in SessionSearchChunk.__table__.columns
        }
        replacements = {
            "id": "md5('prepared-chunk:' || s.id::text)::uuid",
            "session_id": "s.session_id",
            "source_id": "s.id",
            "sort_order": "c.source_order",
        }
        await db.execute(
            text(
                "INSERT INTO session_search_chunks (" + ",".join(values) + ") "
                "SELECT "
                + ",".join(replacements.get(name, ":" + name) for name in values)
                + " FROM session_search_sources s JOIN agent_session_contents c "
                "ON c.id=s.content_id WHERE c.session_id=:session AND s.status='pending'"
            ),
            {**values, "session": hot_session},
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.session_id == hot_session)
            .values(status="indexed", folded_bytes=len(body), chunk_count=1)
        )
    _, tiny_session, _ = await pg_inline(pg, [body] * 32, native="tiny-plan")
    engine = pg["factory"].kw["bind"]
    async with engine.begin() as connection:
        for table in (
            "agent_session_contents",
            "session_search_sources",
            "session_search_chunks",
        ):
            await connection.exec_driver_sql(f"ANALYZE {table}")
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    history = []
    try:
        async with engine.connect() as connection:
            await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            await connection.exec_driver_sql("SET LOCAL statement_timeout='20s'")
            async with AsyncSession(bind=connection) as db:
                repo = SessionSearchRepository(db)
                for session_id in [hot_session] * 5 + [tiny_session]:
                    statements.clear()
                    count = hot_extra + 1 if session_id == hot_session else 32
                    assert await repo.eligible_totals(
                        session_id, SearchScope(EXTRACTOR_VERSION)
                    ) == (count, count * len(body))
                    assert (
                        len(statements) == 1
                    ), "Totals must use one coherent statement"
                    sql, parameters = statements[0]
                    prepared = (
                        (
                            await connection.exec_driver_sql(
                                "SELECT name,generic_plans,custom_plans,pg_backend_pid() AS backend_pid "
                                "FROM pg_prepared_statements "
                                "WHERE statement=$1::TEXT",
                                (sql,),
                            )
                        )
                        .mappings()
                        .one()
                    )
                    history.append(
                        {
                            "session_id": str(session_id),
                            "sql": sql,
                            "uuid_bind_positions": [
                                index
                                for index, value in enumerate(parameters)
                                if isinstance(value, uuid.UUID) and value == session_id
                            ],
                            **dict(prepared),
                        }
                    )
                statement_name = '"' + prepared["name"].replace('"', '""') + '"'
                arguments = ",".join(
                    str(
                        literal(
                            value
                            if isinstance(value, (str, int, type(None)))
                            else str(value)
                        ).compile(
                            dialect=postgresql.dialect(),
                            compile_kwargs={"literal_binds": True},
                        )
                    )
                    for value in parameters
                )
                raw = (
                    await connection.exec_driver_sql(
                        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE "
                        + statement_name
                        + "("
                        + arguments
                        + ")"
                    )
                ).scalar_one()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    plan = json.loads(raw) if isinstance(raw, str) else raw
    visits = {
        relation: sum(
            (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
            * node["Actual Loops"]
            for node in plan_nodes(plan[0]["Plan"])
            if node.get("Relation Name") == relation
        )
        for relation in (
            "session_search_sources",
            "agent_session_contents",
            "session_search_chunks",
        )
    }
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "tiny-prepared-totals-plan.json").write_text(
        json.dumps(
            {"history": history, "visits": visits, "plan": plan}, indent=2, default=str
        )
        + "\n"
    )
    assert visits["session_search_sources"] <= 32 * 3, visits
    assert visits["agent_session_contents"] <= 32 * 3, visits
    # A bounded metadata probe may use the existing 2048-chunk window plus
    # one sentinel, but a tiny request must not walk the unrelated hot tenant.
    assert visits["session_search_chunks"] <= 2049 + 32 * 3, visits

    # Each session must retain a typed bound identity in the same prepared SQL.
    # The natural custom/generic decision is recorded above, not forced here.
    assert len({row["backend_pid"] for row in history}) == 1, history
    assert all(row["uuid_bind_positions"] for row in history), history
    assert all(row["session_id"] not in row["sql"] for row in history), history
    assert len({row["sql"] for row in history}) == 1, history
    assert len({row["name"] for row in history}) == 1, history
    assert [row["generic_plans"] + row["custom_plans"] for row in history] == list(
        range(1, 7)
    ), history


@pytest.mark.timeout(90)
async def test_tiny_coverage_stays_bounded_after_hot_prepared_requests(pg, tmp_path):
    body = b"prepared coverage needle " + b"x" * 1000
    _, hot_session, acknowledgements = await pg_inline(pg, [body], native="hot-plan")
    content_id = uuid.UUID(acknowledgements[0]["content_id"])
    hot_extra = 100_000
    await seed_pending_contents(pg, hot_session, content_id, hot_extra)
    async with pg["factory"].begin() as db:
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.session_id == hot_session)
            .values(status="indexed", folded_bytes=len(body), chunk_count=1)
        )
    _, tiny_session, _ = await pg_inline(pg, [body] * 32, native="tiny-plan")
    engine = pg["factory"].kw["bind"]
    async with engine.begin() as connection:
        for table in (
            "agent_session_contents",
            "session_search_sources",
            "session_search_chunks",
        ):
            await connection.exec_driver_sql(f"ANALYZE {table}")
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append((statement, parameters))

    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    history = []
    try:
        async with engine.connect() as connection:
            await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
            await connection.exec_driver_sql("SET LOCAL statement_timeout='20s'")
            async with AsyncSession(bind=connection) as db:
                repo = SessionSearchRepository(db)
                for session_id in [hot_session] * 5 + [tiny_session]:
                    statements.clear()
                    count = hot_extra + 1 if session_id == hot_session else 32
                    rows = await repo.content_coverage(
                        session_id, EXTRACTOR_VERSION, set()
                    )
                    assert sum(row.count for row in rows) == count
                    assert sum(row.stored_bytes for row in rows) == count * len(body)
                    assert all(row.index_status == "indexed" for row in rows)
                    assert (
                        len(statements) == 1
                    ), "Coverage must use one coherent statement"
                    sql, parameters = statements[0]
                    prepared = (
                        (
                            await connection.exec_driver_sql(
                                "SELECT name,generic_plans,custom_plans FROM pg_prepared_statements "
                                "WHERE statement=$1::TEXT",
                                (sql,),
                            )
                        )
                        .mappings()
                        .one()
                    )
                    history.append({"session_id": str(session_id), **dict(prepared)})
                statement_name = '"' + prepared["name"].replace('"', '""') + '"'
                arguments = ",".join(
                    str(
                        literal(
                            value
                            if isinstance(value, (str, int, type(None)))
                            else str(value)
                        ).compile(
                            dialect=postgresql.dialect(),
                            compile_kwargs={"literal_binds": True},
                        )
                    )
                    for value in parameters
                )
                raw = (
                    await connection.exec_driver_sql(
                        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE "
                        + statement_name
                        + "("
                        + arguments
                        + ")"
                    )
                ).scalar_one()
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    plan = json.loads(raw) if isinstance(raw, str) else raw
    visits = {
        relation: sum(
            (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
            * node["Actual Loops"]
            for node in plan_nodes(plan[0]["Plan"])
            if node.get("Relation Name") == relation
        )
        for relation in (
            "session_search_sources",
            "agent_session_contents",
            "session_search_chunks",
        )
    }
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "tiny-prepared-coverage-plan.json").write_text(
        json.dumps(
            {"history": history, "visits": visits, "plan": plan}, indent=2, default=str
        )
        + "\n"
    )
    assert visits["session_search_sources"] <= 32 * 3, visits
    assert visits["agent_session_contents"] <= 2049 + 32 * 3, visits
    # Tiny coverage must use scoped Content metadata, with at most one
    # bounded probe, independent of unrelated Source and Content growth.
    assert visits["session_search_chunks"] == 0, visits


async def test_known_empty_totals_do_not_read_retained_population(pg, tmp_path):
    _, session_id, _ = await pg_inline(pg, [b"empty scope needle"] * 3)
    engine = pg["factory"].kw["bind"]
    statements = []

    def capture(_connection, _cursor, sql, parameters, _context, _many):
        if sql.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append((sql, parameters))

    plans = []
    event.listen(engine.sync_engine, "before_cursor_execute", capture)
    try:
        async with engine.connect() as connection:
            async with AsyncSession(bind=connection) as db:
                repo = SessionSearchRepository(db)
                for scope in (
                    SearchScope(EXTRACTOR_VERSION, channels=frozenset()),
                    SearchScope(EXTRACTOR_VERSION, failed_anchors=frozenset()),
                    SearchScope(EXTRACTOR_VERSION, work_anchors=frozenset()),
                    SearchScope(
                        EXTRACTOR_VERSION,
                        failed_anchors=frozenset({"c:f1", "c:f2"}),
                        work_anchors=frozenset({"c:w1", "c:w2"}),
                    ),
                ):
                    statements.clear()
                    assert await repo.eligible_totals(session_id, scope) == (0, 0)
                    assert len(statements) == 1
                    sql, parameters = statements[0]
                    raw = (
                        await connection.exec_driver_sql(
                            "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, parameters
                        )
                    ).scalar_one()
                    plan = json.loads(raw) if isinstance(raw, str) else raw
                    visited = sum(
                        (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
                        * node["Actual Loops"]
                        for node in plan_nodes(plan[0]["Plan"])
                        if "Relation Name" in node
                    )
                    plans.append(
                        {"scope": repr(scope), "visited": visited, "plan": plan}
                    )
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", capture)
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "known-empty-totals-plans.json").write_text(
        json.dumps(plans, indent=2, default=str) + "\n"
    )
    assert all(item["visited"] == 0 for item in plans), plans


async def test_eligible_totals_match_original_content_event_scope_matrix(pg):
    body = b"content scope needle"
    raw = prompt(1, "event scope needle")
    result = await post_batch(
        pg,
        [
            rich_record(
                pg["mapping_id"],
                [declaration(body)],
                events=[raw],
                native_session_id="scope-controls",
            )
        ],
    )
    assert result["rejected"] == []
    async with pg["factory"].begin() as db:
        sid = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.workspace_id == pg["workspace_id"],
                AgentSession.native_session_id == "scope-controls",
            )
        )
        sources = (
            await db.scalars(
                select(SessionSearchSource).where(SessionSearchSource.session_id == sid)
            )
        ).all()
        assert len(sources) == 2
        content_source = next(s for s in sources if s.content_id is not None)
        event_source = next(s for s in sources if s.event_id is not None)
        content_id = content_source.content_id
        source_id = content_source.id
        event_source_id = event_source.id
        anchor = event_source.call_anchor
        assert anchor is not None and content_source.call_anchor is None
        scopes = [
            SearchScope(
                EXTRACTOR_VERSION, channels=frozenset({"assistant"}), tool_alias=True
            ),
            SearchScope(
                EXTRACTOR_VERSION,
                channels=frozenset({"tool_output"}),
                tool_anchors=frozenset({anchor}),
                mcp_anchors=frozenset({anchor}),
            ),
            SearchScope(EXTRACTOR_VERSION),
            SearchScope(EXTRACTOR_VERSION, channels=frozenset()),
            SearchScope(EXTRACTOR_VERSION, channels=frozenset({"tool_output"})),
            SearchScope(EXTRACTOR_VERSION, channels=frozenset({"assistant"})),
            SearchScope(EXTRACTOR_VERSION, failed_anchors=frozenset()),
            SearchScope(EXTRACTOR_VERSION, work_anchors=frozenset()),
            SearchScope(EXTRACTOR_VERSION, failed_anchors=frozenset({anchor})),
            SearchScope(EXTRACTOR_VERSION, work_anchors=frozenset({anchor})),
            SearchScope(EXTRACTOR_VERSION, channels=frozenset(), tool_alias=True),
            SearchScope(
                EXTRACTOR_VERSION,
                channels=frozenset(),
                tool_anchors=frozenset({anchor}),
            ),
            SearchScope(
                EXTRACTOR_VERSION, channels=frozenset(), mcp_anchors=frozenset({anchor})
            ),
            SearchScope(
                EXTRACTOR_VERSION,
                failed_anchors=frozenset({"c:f1", "c:f2"}),
                work_anchors=frozenset({"c:w1", "c:w2"}),
            ),
        ]
        cases = [
            ("baseline", None, None),
            ("pending", SessionSearchSource, {"status": "pending"}),
            ("unavailable", SessionSearchSource, {"status": "unavailable"}),
            ("not_text", SessionSearchSource, {"status": "not_text"}),
            ("old_version", SessionSearchSource, {"extractor_version": "old"}),
            ("changed_digest", SessionSearchSource, {"source_digest": "0" * 64}),
            ("null_digest", AgentSessionContent, {"sha256": None}),
            ("event_null_channel", SessionSearchChunk, {"channel": None}),
            ("event_tool_channel", SessionSearchChunk, {"channel": "tool_output"}),
            ("event_pending", SessionSearchSource, {"status": "pending"}),
            ("event_unavailable", SessionSearchSource, {"status": "unavailable"}),
            ("event_not_text", SessionSearchSource, {"status": "not_text"}),
            ("event_old_version", SessionSearchSource, {"extractor_version": "old"}),
            ("event_changed_digest", SessionSearchSource, {"source_digest": "0" * 64}),
        ]
        repo = SessionSearchRepository(db)
        checked = 0
        for name, model, values in cases:
            nested = await db.begin_nested()
            try:
                if model is SessionSearchSource:
                    await db.execute(
                        update(SessionSearchSource)
                        .where(
                            SessionSearchSource.id
                            == (
                                event_source_id
                                if name.startswith("event_")
                                else source_id
                            )
                        )
                        .values(**values)
                    )
                elif model is AgentSessionContent:
                    await db.execute(
                        update(AgentSessionContent)
                        .where(AgentSessionContent.id == content_id)
                        .values(**values)
                    )
                elif model is SessionSearchChunk:
                    await db.execute(
                        update(SessionSearchChunk)
                        .where(
                            SessionSearchChunk.source_id
                            == (
                                event_source_id
                                if name.startswith("event_")
                                else source_id
                            )
                        )
                        .values(**values)
                    )
                for scope in scopes:
                    expected = await original_eligible_totals(repo, sid, scope)
                    public = await repo.eligible_totals(sid, scope)
                    assert public == expected, (name, scope, expected, public)
                    facts = await repo.content_facts(sid, scope)
                    content_expected = tuple(
                        (
                            await db.execute(
                                repo._scanned(
                                    (
                                        func.count(
                                            func.distinct(SessionSearchChunk.source_id)
                                        ),
                                        func.coalesce(
                                            func.sum(SessionSearchChunk.owned_bytes), 0
                                        ),
                                    ),
                                    sid,
                                    scope,
                                ).where(SessionSearchSource.content_id.is_not(None))
                            )
                        ).one()
                    )
                    assert facts.eligible_totals == content_expected, (
                        name,
                        scope,
                        content_expected,
                        facts.eligible_totals,
                    )
                    if (
                        scope.failed_anchors == frozenset()
                        or scope.work_anchors == frozenset()
                        or (
                            scope.failed_anchors is not None
                            and scope.work_anchors is not None
                            and not (scope.failed_anchors & scope.work_anchors)
                        )
                        or (
                            scope.channels == frozenset()
                            and not scope.tool_alias
                            and scope.tool_anchors is None
                            and scope.mcp_anchors is None
                        )
                    ):
                        assert expected == (0, 0)
                    if supports_eligibility_scope(scope):
                        dense = tuple(
                            (
                                await db.execute(_large_eligibility_totals(sid, scope))
                            ).one()
                        )
                        assert dense == expected, (name, scope, expected, dense)
                    else:
                        assert scope.channels is not None
                    checked += 1
            finally:
                await nested.rollback()
        assert checked == 196


@pytest.mark.parametrize("chunk_channel", [None, "assistant"])
async def test_content_facts_scope_uses_content_channel_and_source_anchor(
    pg, chunk_channel
):
    body = b"content metadata scope needle"
    _, session_id, acknowledgements = await pg_inline(pg, [body])
    content_id = uuid.UUID(acknowledgements[0]["content_id"])
    async with pg["factory"].begin() as db:
        source_id = await db.scalar(
            select(SessionSearchSource.id).where(
                SessionSearchSource.content_id == content_id
            )
        )
        await db.execute(
            update(SessionSearchSource)
            .where(SessionSearchSource.id == source_id)
            .values(call_anchor="content-call")
        )
        await db.execute(
            update(SessionSearchChunk)
            .where(SessionSearchChunk.source_id == source_id)
            .values(channel=chunk_channel)
        )
        repo = SessionSearchRepository(db)
        for scope, expected in (
            (SearchScope(EXTRACTOR_VERSION), (1, len(body))),
            (
                SearchScope(EXTRACTOR_VERSION, channels=frozenset({"tool_output"})),
                (1, len(body)),
            ),
            (
                SearchScope(EXTRACTOR_VERSION, channels=frozenset({"assistant"})),
                (0, 0),
            ),
            (
                SearchScope(EXTRACTOR_VERSION, channels=frozenset(), tool_alias=True),
                (1, len(body)),
            ),
            (
                SearchScope(
                    EXTRACTOR_VERSION,
                    failed_anchors=frozenset({"content-call"}),
                ),
                (1, len(body)),
            ),
            (
                SearchScope(
                    EXTRACTOR_VERSION, work_anchors=frozenset({"different-call"})
                ),
                (0, 0),
            ),
        ):
            facts = await repo.content_facts(session_id, scope)
            assert facts.eligible_totals == expected, (chunk_channel, scope)


def test_fixed_coverage_bounds_remain_visible_to_prepared_plans():
    """Historical compile control for the retired coverage query only."""
    session_id = uuid.UUID("c8d3c3fd-31aa-c17c-00c3-1c45ec257340")
    unverified_id = uuid.UUID(int=100)
    version = "caller-extractor-version"
    query = coverage_totals_query(session_id, version, {unverified_id})
    compiled = query.compile(
        dialect=asyncpg_dialect(), compile_kwargs={"render_postcompile": True}
    )
    sql = str(compiled)
    assert str(session_id) not in sql
    assert str(unverified_id) not in sql
    assert version not in sql
    assert session_id in compiled.params.values()
    assert unverified_id in compiled.params.values()
    assert version in compiled.params.values()
    for fixed in (
        r"LIMIT\s+2049\b",
        r"LIMIT\s+1\b",
        r"OFFSET\s+0\b",
        r"<=\s*2048\b",
        r">\s*2048\b",
    ):
        assert re.search(fixed, sql), (fixed, sql)


async def test_small_coverage_does_not_repeat_source_lookups(pg, tmp_path):
    body = b"small coverage current needle"
    _, session_id, acknowledgements = await pg_inline(pg, [body] * 32)
    assert len(acknowledgements) == 32
    expected = [
        ContentCoverageRow(
            state="available",
            coverage="captured",
            is_text=True,
            index_status="indexed",
            unverified=False,
            count=32,
            stored_bytes=32 * len(body),
            stored_known=32,
            original_bytes=32 * len(body),
            original_known=32,
        )
    ]
    engine = pg["factory"].kw["bind"]
    statements = []

    def capture(_connection, _cursor, statement, parameters, _context, _many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append((statement, parameters))

    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    output = directory / "small-coverage-lookup-count.json"
    async with pg["factory"]() as db:
        await db.execute(text("SET TRANSACTION READ ONLY"))
        await db.execute(text("SET LOCAL statement_timeout='10s'"))
        event.listen(engine.sync_engine, "before_cursor_execute", capture)
        try:
            rows = await SessionSearchRepository(db).content_coverage(
                session_id, EXTRACTOR_VERSION, set()
            )
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", capture)
        receipt = {
            "rows": [asdict(row) for row in rows],
            "expected": [asdict(row) for row in expected],
            "statements": statements,
        }
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
        assert len(statements) == 1, "Coverage remains one coherent statement"
        sql, parameters = statements[0]
        connection = await db.connection()
        raw = (
            await connection.exec_driver_sql(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, parameters
            )
        ).scalar_one()
    plan = json.loads(raw) if isinstance(raw, str) else raw
    sources = [
        node
        for node in plan_nodes(plan[0]["Plan"])
        if node.get("Relation Name") == "session_search_sources"
    ]
    source_loops = sum(node["Actual Loops"] for node in sources)
    source_visits = sum(
        (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
        * node["Actual Loops"]
        for node in sources
    )
    receipt.update(plan=plan, source_loops=source_loops, source_visits=source_visits)
    output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
    assert rows == expected
    assert sources
    # Tiny tables may use a sequential scan inside each lookup. Count executed
    # lookups independently of how many rows each chosen access path visits.
    assert source_loops <= 32, receipt
