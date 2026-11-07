# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Sparse Source statistics must not multiply the content metadata join."""

import hashlib
import json
import os
import time
import uuid
from dataclasses import asdict, astuple

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchSource as Source
from app.models.session_search import SessionSearchChunk as Chunk
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.services import session_search_index as indexing
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.conftest import (
    _empty_iap_claims_cache as claims_cache_fixture,
    _integrations_token_key as integrations_key_fixture,
    content_storage as storage_fixture,
)
from tests.rejected_session_search_metadata import coverage_totals_query
from tests.test_session_content_postgres import (
    pg as content_postgres_fixture,
    post_batch,
    session_record,
)
from tests.test_session_search_actual_facts_xid_postgres import prepared_literal
from tests.test_session_search_index_migration_postgres import (
    migration_database as index_migration_database_fixture,
)
from tests.test_session_search_postgres import receipt_path
from tests.test_session_search_latency_postgres import original_eligible_totals
from tests.rich_capture import declaration, upload

migration_database = index_migration_database_fixture
content_storage = storage_fixture
_empty_iap_claims_cache = claims_cache_fixture
_integrations_token_key = integrations_key_fixture
pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
SCALE = 100_000
INDEXED = 12
CONTENT_COUNT = SCALE + 3 + INDEXED
CALLS = 8
SCOPE = SearchScope(EXTRACTOR_VERSION)


def preserve(tmp_path, name, value):
    with receipt_path(tmp_path, "sparse-source-" + name + ".json").open("x") as stream:
        json.dump(value, stream, indent=2, default=str)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())


@pytest.fixture
async def sparse_pg(migration_database, monkeypatch, tmp_path):
    # A fresh relation history makes the sparse statistics independent of CAP.
    await (await migration_database.cli("upgrade", "head")).finish()
    async with migration_database.engine.connect() as connection:
        await connection.execute(text("SET TRANSACTION READ ONLY"))
        await connection.execute(text("SET LOCAL statement_timeout='10s'"))
        identity = dict(
            (
                await connection.execute(
                    text(
                        "SELECT current_database() AS database,d.oid::bigint AS oid,"
                        "pg_get_userbyid(d.datdba) AS owner,current_user AS role,"
                        "current_setting('data_directory') AS data_directory,"
                        "current_setting('work_mem') AS work_mem,"
                        "(SELECT version_num FROM alembic_version) AS head "
                        "FROM pg_database d WHERE d.datname=current_database()"
                    )
                )
            )
            .mappings()
            .one()
        )
        preserve(tmp_path, "fixture-before", identity)
        assert identity["database"] == migration_database.name
        assert identity["owner"] == identity["role"]
        assert identity["head"] == "130" and identity["work_mem"] == "64MB"
        for model in (Content, Source, Chunk):
            assert await connection.scalar(select(func.count()).select_from(model)) == 0
    async with migration_database.engine.connect() as connection:
        connection = await connection.execution_options(isolation_level="AUTOCOMMIT")
        name = connection.dialect.identifier_preparer.quote_identifier(
            migration_database.name
        )
        await connection.execute(
            text("ALTER DATABASE " + name + " SET statement_timeout='30s'")
        )
        await connection.execute(
            text("ALTER DATABASE " + name + " SET lock_timeout='5s'")
        )
    await migration_database.engine.dispose()
    async with migration_database.engine.connect() as connection:
        configured = dict(
            (
                await connection.execute(
                    text(
                        "SELECT current_database() AS database,d.oid::bigint AS oid,"
                        "pg_get_userbyid(d.datdba) AS owner,current_user AS role,"
                        "current_setting('statement_timeout') AS statement_timeout,"
                        "current_setting('lock_timeout') AS lock_timeout "
                        "FROM pg_database d WHERE d.datname=current_database()"
                    )
                )
            )
            .mappings()
            .one()
        )
        preserve(tmp_path, "fixture-operational-settings", configured)
        assert all(
            configured[key] == identity[key]
            for key in ("database", "oid", "owner", "role")
        )
        assert (
            configured["statement_timeout"] == "30s"
            and configured["lock_timeout"] == "5s"
        )
    with monkeypatch.context() as environment:
        environment.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", migration_database.url)
        fixture = content_postgres_fixture.__wrapped__()
        try:
            yield await fixture.__anext__()
        finally:
            await fixture.aclose()


async def statistics(connection):
    await connection.execute(text("SELECT pg_stat_clear_snapshot()"))
    relation = (
        (
            await connection.execute(
                text("""
        SELECT c.oid::bigint, c.relname, c.reltuples, c.relpages, c.relallvisible, c.reloptions,
               s.n_live_tup,s.n_dead_tup,s.n_mod_since_analyze,s.n_tup_ins,s.n_tup_upd,
               s.last_analyze,s.last_autoanalyze,s.analyze_count,s.autoanalyze_count,
               s.last_autovacuum,s.autovacuum_count
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_stat_user_tables s ON s.relid=c.oid
        WHERE n.nspname='public' AND c.relname IN
          ('agent_session_contents','session_search_sources','session_search_chunks')
        ORDER BY c.relname
    """)
            )
        )
        .mappings()
        .all()
    )
    columns = (
        (
            await connection.execute(
                text("""
        SELECT tablename,attname,null_frac,n_distinct,most_common_vals::text,
               most_common_freqs::text,histogram_bounds::text,correlation
        FROM pg_stats WHERE schemaname='public' AND tablename IN
          ('agent_session_contents','session_search_sources')
          AND attname IN ('id','session_id','content_id','status','extractor_version')
        ORDER BY tablename,attname
    """)
            )
        )
        .mappings()
        .all()
    )
    settings = [
        dict(row)
        for row in (
            await connection.execute(
                text(
                    "SELECT name,setting,boot_val FROM pg_settings WHERE name IN ('autovacuum_analyze_threshold','autovacuum_analyze_scale_factor') ORDER BY name"
                )
            )
        )
        .mappings()
        .all()
    ]
    return {
        "settings": settings,
        "relations": [dict(row) for row in relation],
        "columns": [dict(row) for row in columns],
        "observed_at_ns": time.time_ns(),
    }


def canonical(rows):
    grouped = {}
    for row in rows:
        values = astuple(row) if hasattr(row, "__dataclass_fields__") else tuple(row)
        key = (*values[:3], values[3] or "pending", values[4])
        prior = grouped.setdefault(key, [0] * 5)
        for number, value in enumerate(values[5:]):
            prior[number] += int(value)
    return sorted([(*key, *value) for key, value in grouped.items()], key=repr)


def nodes(plan):
    yield plan
    for child in plan.get("Plans", []):
        yield from nodes(child)


def join_reject_lower_bound(plan):
    total, observations = 0, []
    for node in nodes(plan):
        if "Rows Removed by Join Filter" not in node:
            continue
        loops = node.get("Actual Loops")
        rejected = node["Rows Removed by Join Filter"]
        assert type(loops) is int and loops >= 0, ("Invalid loop counter", node)
        assert type(rejected) is int and rejected >= 0, (
            "Invalid join rejection counter",
            node,
        )
        assert loops or rejected == 0, ("Rejected rows on an unexecuted node", node)
        # EXPLAIN rounds per-loop averages; ceil of the lower half-step is a
        # conservative integer lower bound, including exact rounding ties.
        lower = (
            rejected if loops == 1 else max(0, ((2 * rejected - 1) * loops + 1) // 2)
        )
        total += lower
        observations.append(
            {
                "node_type": node["Node Type"],
                "actual_loops": loops,
                "reported_rejections_per_loop": rejected,
                "lower_bound": lower,
                "join_filter": node.get("Join Filter"),
            }
        )
    return total, observations


@pytest.mark.timeout(240)
async def test_sparse_source_statistics_do_not_multiply_metadata_join(
    sparse_pg, monkeypatch, tmp_path
):
    pg = sparse_pg
    factory = pg["factory"]
    engine = factory.kw["bind"]
    templates = []

    async def paused(*_args, **_kwargs):
        return None

    # Exact route template bodies and current_mix bulk projection; only object
    # scheduling is paused while uploading the three unindexed templates.
    with monkeypatch.context() as pause:
        pause.setattr(indexing.SessionSearchObjectProcessor, "process_source", paused)
        for size in (1024, 65536, 1048576):
            body = (b"route_needle ordinary " + b"x " * (size // 2))[:size]
            [ack] = (
                await post_batch(
                    pg,
                    [
                        session_record(
                            pg,
                            "route-current_mix",
                            [declaration(body, delivery="upload")],
                        )
                    ],
                )
            )["contents"]
            await upload(pg["client"], pg, ack, body)
            templates.append((uuid.UUID(ack["content_id"]), body))

    async with factory.begin() as db:
        assert not (
            await db.execute(
                text("SELECT 1 FROM session_search_backfill_claims LIMIT 1")
            )
        ).first()
        assert not (
            await db.execute(text("SELECT 1 FROM session_search_backfill_runs LIMIT 1"))
        ).first()
        original = await db.get(Content, templates[0][0])
        session_id = original.session_id
        fields = [column.name for column in Content.__table__.columns]
        replacements = {
            "id": "(lpad(to_hex(g),5,'0')||repeat('0',27))::uuid",
            "content_key": "md5('route:'||g::text)||md5('route2:'||g::text)",
            "source_order": "g",
            "preview": "NULL",
        }
        for field, expression in {
            "inline_text": "CAST(:body AS text)",
            "byte_count": "1024",
            "sha256": "CAST(:digest AS text)",
            "storage_backend": "NULL",
            "storage_key": "NULL",
            "delivery": "'inline'",
            "chunk_count": "NULL",
        }.items():
            replacements[field] = (
                f'CASE WHEN g%32<>0 THEN {expression} ELSE c."{field}" END'
            )
        projection = ",".join(
            replacements.get(field, 'c."' + field + '"') for field in fields
        )
        for kind, (identity, _body) in enumerate(templates):
            await db.execute(
                text(
                    "INSERT INTO agent_session_contents ("
                    + ",".join('"' + field + '"' for field in fields)
                    + ") SELECT "
                    + projection
                    + " FROM generate_series(1,100000) g JOIN agent_session_contents c ON c.id=:id WHERE g%3=:kind"
                ),
                {
                    "id": identity,
                    "kind": kind,
                    "body": templates[0][1].decode(),
                    "digest": hashlib.sha256(templates[0][1]).hexdigest(),
                },
            )
        for name in (
            "agent_session_contents",
            "agent_session_events",
            "agent_sessions",
            "session_search_sources",
        ):
            await db.execute(text("ANALYZE " + name))
    async with engine.connect() as connection:
        initial = await statistics(connection)
        counts = dict(
            (
                await connection.execute(
                    text("""
            SELECT (SELECT count(*) FROM agent_session_contents) AS contents,
                   count(*) AS sources,count(*) FILTER(WHERE status='pending') AS pending
            FROM session_search_sources
        """)
                )
            )
            .mappings()
            .one()
        )
    preserve(
        tmp_path, "initial-sparse-statistics", {"statistics": initial, "counts": counts}
    )
    assert counts == {"contents": 100003, "sources": 3, "pending": 3}
    assert (
        next(
            row
            for row in initial["relations"]
            if row["relname"] == "session_search_sources"
        )["reltuples"]
        == 3
    )

    bodies = [f"sparse current inline {number}".encode() for number in range(INDEXED)]
    accepted = await post_batch(
        pg,
        [
            session_record(
                pg,
                "route-current_mix",
                [
                    declaration(body, order=SCALE + number + 1)
                    for number, body in enumerate(bodies)
                ],
            )
        ],
    )
    preserve(tmp_path, "inline-ingest", accepted)
    assert accepted["rejected"] == [] and len(accepted["contents"]) == INDEXED
    async with factory() as db:
        growth = dict(
            (
                await db.execute(
                    text("""
            SELECT (SELECT count(*) FROM agent_session_contents) AS contents,
                   count(*) AS sources,count(*) FILTER (WHERE status='pending') AS pending,
                   count(*) FILTER (WHERE status='indexed') AS indexed,
                   count(*) FILTER (WHERE event_id IS NOT NULL) AS events,
                   count(*) FILTER (WHERE session_id<>:session) AS other_session
            FROM session_search_sources
        """),
                    {"session": session_id},
                )
            )
            .mappings()
            .one()
        )
        counters = (
            (
                await db.execute(
                    text("""
            SELECT s.id,s.folded_bytes,s.chunk_count,
                   count(k.id) AS actual_chunks,coalesce(sum(k.owned_bytes),0) AS actual_bytes
            FROM session_search_sources s LEFT JOIN session_search_chunks k ON k.source_id=s.id
            WHERE s.status='indexed' GROUP BY s.id ORDER BY s.id
        """)
                )
            )
            .mappings()
            .all()
        )
    preserve(
        tmp_path,
        "indexed-growth",
        {"counts": growth, "counters": [dict(row) for row in counters]},
    )
    assert growth == {
        "contents": CONTENT_COUNT,
        "sources": 15,
        "pending": 3,
        "indexed": INDEXED,
        "events": 0,
        "other_session": 0,
    }
    assert len(counters) == INDEXED
    assert all(
        row["chunk_count"] == row["actual_chunks"] == 1
        and row["folded_bytes"] == row["actual_bytes"]
        for row in counters
    )

    async with engine.connect() as connection:
        await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        await connection.exec_driver_sql("SET LOCAL statement_timeout='10s'")
        await connection.exec_driver_sql("SET LOCAL lock_timeout='5s'")
        before_measurement = await statistics(connection)
        preserve(tmp_path, "before-first-facts", before_measurement)
        backend_pid = await connection.scalar(text("SELECT pg_backend_pid()"))
        captured = []

        def capture(_connection, _cursor, statement, parameters, _context, _many):
            if statement.lstrip().upper().startswith(("SELECT", "WITH")):
                captured.append((statement, parameters))

        async with AsyncSession(bind=connection) as db:
            repo = SessionSearchRepository(db)
            observations = []
            for number in range(CALLS):
                preserve(
                    tmp_path,
                    f"facts-call-{number + 1:02d}-intent",
                    {
                        "ordinal": number + 1,
                        "backend_pid": backend_pid,
                        "session_id": str(session_id),
                        "at_ns": time.time_ns(),
                    },
                )
                captured.clear()
                event.listen(engine.sync_engine, "before_cursor_execute", capture)
                before = time.perf_counter()
                try:
                    totals = await repo.eligible_totals(session_id, SCOPE)
                except BaseException as error:
                    preserve(
                        tmp_path,
                        f"facts-call-{number + 1:02d}-failure",
                        {
                            "ordinal": number + 1,
                            "elapsed_s": time.perf_counter() - before,
                            "error": repr(error),
                            "captured": captured,
                        },
                    )
                    raise
                finally:
                    elapsed = time.perf_counter() - before
                    event.remove(engine.sync_engine, "before_cursor_execute", capture)
                assert len(captured) == 1
                sql, parameters = captured[0]
                facts = repo._coverage_reuse.facts
                prepared = dict(
                    (
                        await connection.exec_driver_sql(
                            "SELECT name,generic_plans,custom_plans,pg_backend_pid() AS backend_pid "
                            "FROM pg_prepared_statements WHERE statement=$1::TEXT",
                            (sql,),
                        )
                    )
                    .mappings()
                    .one()
                )
                observation = {
                    "ordinal": number + 1,
                    "elapsed_s": elapsed,
                    "sql": sql,
                    "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                    "parameters": parameters,
                    "totals": totals,
                    "facts": asdict(facts),
                    "prepared": prepared,
                    "scope": asdict(SCOPE),
                }
                preserve(tmp_path, f"first-facts-{number + 1:02d}", observation)
                observations.append(observation)
                assert prepared["backend_pid"] == backend_pid
                assert totals[0] == INDEXED and facts.eligible_totals == totals
                assert sum(row.count for row in facts.coverage_rows) == CONTENT_COUNT
                assert facts.snapshot and facts.xid is None
            after_plain = await statistics(connection)
            preserve(tmp_path, "statistics-after-eight-plain", after_plain)
            statement_name = '"' + prepared["name"].replace('"', '""') + '"'
            arguments = ",".join(prepared_literal(value) for value in parameters)
            replay = (
                "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) EXECUTE "
                + statement_name
                + "("
                + arguments
                + ")"
            )
            started_plan = time.perf_counter()
            raw = (await connection.exec_driver_sql(replay)).scalar_one()
            replay_elapsed = time.perf_counter() - started_plan
            plan = json.loads(raw) if isinstance(raw, str) else raw
            source_nodes = [
                node
                for node in nodes(plan[0]["Plan"])
                if node.get("Relation Name") == "session_search_sources"
            ]
            after_replay = await statistics(connection)
            preserve(
                tmp_path,
                "prepared-plan-replay",
                {
                    "query_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                    "explain_sql": replay,
                    "elapsed_s": replay_elapsed,
                    "plan": plan,
                    "source_nodes": source_nodes,
                    "physical_count_note": "Raw per-loop rounded PostgreSQL Actual Rows and filtered counters retained; no exact-visit inference from rounded averages.",
                    "statistics": after_replay,
                },
            )
            # Independent chunk and late-coverage oracles run only after every
            # first plain call and the plan replay, so they cannot warm the sample.
            expected_totals = await original_eligible_totals(repo, session_id, SCOPE)
            expected_rows = (
                await db.execute(
                    coverage_totals_query(session_id, EXTRACTOR_VERSION, set())
                )
            ).all()
            preserve(
                tmp_path,
                "semantic-oracles",
                {"totals": expected_totals, "coverage": canonical(expected_rows)},
            )
            assert all(tuple(row["totals"]) == expected_totals for row in observations)
            assert canonical(facts.coverage_rows) == canonical(expected_rows)
    source_epochs = [
        next(
            row
            for row in snapshot["relations"]
            if row["relname"] == "session_search_sources"
        )
        for snapshot in (initial, before_measurement, after_plain, after_replay)
    ]
    epoch_fields = (
        "reltuples",
        "last_analyze",
        "last_autoanalyze",
        "analyze_count",
        "autoanalyze_count",
    )
    sparse_epoch_preserved = all(
        all(row[field] == source_epochs[0][field] for field in epoch_fields)
        for row in source_epochs[1:]
    )
    rejected_lower_bound, rejection_nodes = join_reject_lower_bound(plan[0]["Plan"])
    preserve(
        tmp_path,
        "join-work",
        {
            "source_sparse_analyze_epoch_preserved": sparse_epoch_preserved,
            "source_epoch_fields": epoch_fields,
            "source_epochs": source_epochs,
            "join_reject_lower_bound": rejected_lower_bound,
            "allowed_join_reject_lower_bound": CONTENT_COUNT,
            "join_rejection_nodes": rejection_nodes,
            "plain_calls": CALLS,
            "indexed_sources": INDEXED,
            "content_rows": CONTENT_COUNT,
            "counting": "Integer lower bound from per-loop rounded join rejection counters; Workers are not added twice. No clamping to the acceptance bound or exclusion of prefix/foreign work.",
        },
    )
    assert (
        sparse_epoch_preserved
    ), "The test must retain its observed sparse Source statistics epoch"
    assert rejected_lower_bound <= CONTENT_COUNT, (
        f"Metadata discarded at least {rejected_lower_bound} join pairs for "
        f"{CONTENT_COUNT} Contents and only {INDEXED} current Sources"
    )
