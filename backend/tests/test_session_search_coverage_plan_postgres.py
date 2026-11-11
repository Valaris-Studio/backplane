# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Controlled PostgreSQL coverage work after natural prepared-plan reuse.

This is a SQL physical regression, not a latency or migration qualification.
An owned schema clones the migrated table/index definitions; only missing
provisional metadata covers are added there. One setup VACUUM (ANALYZE) makes
index-only work observable independently of recently modified heap pages.
Authorization, graph constraints and classification edge cases have separate
route/semantic tests; LIKE does not copy foreign keys into this physical fixture.
"""

import hashlib
import json
import os
import time
import traceback
import uuid
from dataclasses import asdict
from pathlib import Path

import pytest
from sqlalchemy import event, literal, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.models.agent_session import AgentSessionContent
from app.repositories.session_search import SessionSearchRepository
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rich_capture import declaration
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_content_postgres import session_record
from tests.test_session_search import paused_object_indexing as pause_processor_fixture

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

TABLES = (
    "agent_session_contents",
    "session_search_sources",
    "session_search_chunks",
)
# Independent final-index contract, not imported from a migration or model.
COVERS = (
    (
        "ix_session_search_chunks_metadata",
        TABLES[2],
        ("session_id", "source_id"),
        ("owned_bytes", "channel"),
        None,
    ),
    (
        "ix_session_search_sources_content_metadata",
        TABLES[1],
        ("session_id", "content_id"),
        (),
        "((content_id IS NOT NULL) AND ((status)::text <> 'pending'::text))",
    ),
    (
        "ix_agent_session_contents_search_metadata",
        TABLES[0],
        ("session_id", "id", "sha256"),
        (
            "state",
            "coverage",
            "media_type",
            "byte_count",
            "original_byte_count",
            "channel",
        ),
        None,
    ),
    (
        "ix_agent_session_contents_search_session",
        TABLES[0],
        ("session_id", "id"),
        (),
        None,
    ),
    (
        "ix_session_search_sources_event_metadata",
        TABLES[1],
        ("session_id", "id"),
        ("status", "extractor_version", "event_id", "call_anchor"),
        "(event_id IS NOT NULL)",
    ),
    (
        "ix_session_search_sources_indexed_metadata",
        TABLES[1],
        ("status", "extractor_version", "content_id"),
        ("source_digest", "id"),
        None,
    ),
)


def nodes(plan):
    yield plan
    for child in plan.get("Plans", []):
        yield from nodes(child)


async def index_catalog(connection, schema):
    return [
        dict(row)
        for row in (
            await connection.execute(
                text("""
        SELECT ci.relname AS name, ct.relname AS table_name, am.amname AS method,
               i.indisunique AS unique, i.indisvalid AS valid,
               i.indisready AS ready, i.indislive AS live,
               i.indoption::text AS options,
               pg_get_expr(i.indpred, i.indrelid) AS predicate,
               pg_get_expr(i.indexprs, i.indrelid) AS expressions,
               ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,n)
                     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                     WHERE k.n<=i.indnkeyatts ORDER BY k.n) AS keys,
               ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY k(attnum,n)
                     JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                     WHERE k.n>i.indnkeyatts ORDER BY k.n) AS included,
               ARRAY(SELECT opc.opcdefault FROM unnest(i.indclass) WITH ORDINALITY c(oid,n)
                     JOIN pg_opclass opc ON opc.oid=c.oid ORDER BY c.n) AS default_opclasses,
               pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class ci ON ci.oid=i.indexrelid
        JOIN pg_class ct ON ct.oid=i.indrelid
        JOIN pg_namespace ns ON ns.oid=ct.relnamespace
        JOIN pg_am am ON am.oid=ci.relam
        WHERE ns.nspname=:schema AND ct.relname IN
          ('agent_session_contents','session_search_sources','session_search_chunks')
        ORDER BY ct.relname,ci.relname
    """),
                {"schema": schema},
            )
        ).mappings()
    ]


def assert_cover(index, spec):
    _, table, keys, included, predicate = spec
    assert index["table_name"] == table, index
    assert index["method"] == "btree" and not index["unique"], index
    assert index["valid"] and index["ready"] and index["live"], index
    assert index["keys"] == list(keys) and index["included"] == list(included), index
    assert index["options"] == " ".join("0" for _ in keys), index
    assert index["default_opclasses"] == [True] * len(keys), index
    assert index["expressions"] is None, index
    assert index["predicate"] == predicate, index


def execute_arguments(parameters):
    return ",".join(
        str(
            literal(str(value) if isinstance(value, uuid.UUID) else value).compile(
                dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
            )
        )
        for value in parameters
    )


@pytest.mark.timeout(180)
async def test_half_current_coverage_does_not_spill_after_natural_generic_plan(
    pg, tmp_path
):
    directory = Path(os.getenv("SESSION_SEARCH_LATENCY_EVIDENCE", str(tmp_path)))
    directory.mkdir(parents=True, exist_ok=True)
    receipt_path = directory / "half-current-coverage-prepared-plan.json"
    schema = "coverage_plan_" + uuid.uuid4().hex
    receipt = {
        "schema": schema,
        "physical_rows": 1_000_000,
        "sessions": 10,
        "hot_rows": 900_000,
        "current_fraction": 0.5,
        "raw_coverage_oracle": "20eaade deployed content_coverage preserves matching pending Source status",
        "setup_maintenance": "one VACUUM (ANALYZE) per owned table",
        "provisional_indexes": COVERS,
        "history": [],
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "repository_sha256": hashlib.sha256(
            Path(__file__)
            .parents[1]
            .joinpath("app/repositories/session_search.py")
            .read_bytes()
        ).hexdigest(),
    }

    def save():
        receipt_path.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

    save()
    body = (b"coverage physical needle " + b"x" * 1024)[:1024]
    payload = {"records": [session_record(pg, schema, [declaration(body)])]}
    receipt["template_request"] = payload
    save()
    response = await pg["client"].post(
        "/api/companion/ingest", json=payload, headers=pg["headers"]
    )
    receipt["template_response"] = {
        "status": response.status_code,
        "body": response.text,
    }
    save()
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["rejected"] == [], result
    assert len(result["contents"]) == 1, result
    template = uuid.UUID(result["contents"][0]["content_id"])
    admin_engine = pg["factory"].kw["bind"]
    engine = create_async_engine(
        admin_engine.url,
        poolclass=NullPool,
        hide_parameters=True,
        connect_args={"server_settings": {"search_path": schema + ",public"}},
    )
    created = False
    failed = False
    try:
        async with admin_engine.begin() as connection:
            receipt["database"] = dict(
                (
                    await connection.exec_driver_sql(
                        "SELECT current_database() AS database,current_user AS role,"
                        "current_setting('server_version') AS version,"
                        "current_setting('plan_cache_mode') AS plan_cache_mode,"
                        "current_setting('work_mem') AS work_mem,"
                        "current_setting('hash_mem_multiplier') AS hash_mem_multiplier,"
                        "current_setting('jit') AS jit,"
                        "current_setting('max_parallel_workers_per_gather') AS parallel_workers"
                    )
                )
                .mappings()
                .one()
            )
            receipt["public_indexes"] = await index_catalog(connection, "public")
            save()
            assert receipt["database"]["plan_cache_mode"] == "auto"
            assert receipt["database"]["work_mem"] == "64MB"
            for spec in COVERS:
                for index in receipt["public_indexes"]:
                    if index["name"] == spec[0]:
                        assert_cover(index, spec)
            await connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
            for table in TABLES:
                await connection.exec_driver_sql(
                    f'CREATE TABLE "{schema}"."{table}" '
                    f'(LIKE public."{table}" INCLUDING ALL)'
                )
        created = True
        async with engine.begin() as connection:
            catalog = await index_catalog(connection, schema)
            receipt["cloned_indexes"] = catalog
            save()
            for spec in COVERS:
                name, table, keys, included, predicate = spec
                # Reuse copied covers, but refuse a near-match instead of adding
                # another index to conceal a changed production definition.
                candidates = [
                    item
                    for item in catalog
                    if item["table_name"] == table
                    and not item["unique"]
                    and item["keys"] == list(keys)
                ]
                if candidates:
                    assert len(candidates) == 1, candidates
                    assert_cover(candidates[0], spec)
                    continue
                ddl = (
                    f'CREATE INDEX "{name}" ON "{schema}"."{table}" '
                    f'({",".join(keys)})'
                    + (f' INCLUDE ({",".join(included)})' if included else "")
                )
                await connection.exec_driver_sql(
                    ddl + (" WHERE " + predicate if predicate else "")
                )
            receipt["fixture_indexes"] = await index_catalog(connection, schema)
            save()
            for spec in COVERS:
                matching = [
                    item
                    for item in receipt["fixture_indexes"]
                    if item["table_name"] == spec[1]
                    and not item["unique"]
                    and item["keys"] == list(spec[2])
                ]
                assert len(matching) == 1, matching
                assert_cover(matching[0], spec)
            columns = [column.name for column in AgentSessionContent.__table__.columns]
            replacements = {
                "id": "md5(:prefix || ':content:' || g::text)::uuid",
                "session_id": "md5(:prefix || ':session:' || CASE WHEN g<=900000 THEN 0 "
                "ELSE 1+(g-900001)%9 END::text)::uuid",
                "content_key": "md5(:prefix || g::text) || md5(g::text || :prefix)",
                "source_order": "g",
            }
            await connection.execute(
                text(
                    "INSERT INTO agent_session_contents ("
                    + ",".join(columns)
                    + ") SELECT "
                    + ",".join(
                        replacements.get(name, f'c."{name}"') for name in columns
                    )
                    + " FROM public.agent_session_contents c CROSS JOIN generate_series(1,1000000) g "
                    "WHERE c.id=:template"
                ),
                {"prefix": schema, "template": template},
            )
            await connection.execute(
                text("""
                INSERT INTO session_search_sources
                  (id,session_id,content_id,status,extractor_version,source_digest,
                   byte_count,folded_bytes,chunk_count)
                SELECT md5('source:'||c.id::text)::uuid,c.session_id,c.id,
                  CASE WHEN c.source_order%2=0 THEN 'indexed' ELSE 'pending' END,
                  :version,c.sha256,c.byte_count,
                  CASE WHEN c.source_order%2=0 THEN c.byte_count ELSE 0 END,
                  CASE WHEN c.source_order%2=0 THEN 1 ELSE 0 END
                FROM agent_session_contents c
            """),
                {"version": EXTRACTOR_VERSION},
            )
            await connection.execute(
                text("""
                INSERT INTO session_search_chunks
                  (id,session_id,source_id,sort_us,sort_order,ordinal,field,channel,
                   segment_byte_start,segment_byte_end,byte_start,owned_chars,owned_bytes,folded_text)
                SELECT md5('chunk:'||s.id::text)::uuid,s.session_id,s.id,0,c.source_order,
                  0,'body',c.channel,0,c.byte_count,0,length(c.inline_text),c.byte_count,c.inline_text
                FROM session_search_sources s JOIN agent_session_contents c ON c.id=s.content_id
                WHERE s.status='indexed'
            """)
            )
            distribution = (
                (
                    await connection.exec_driver_sql(
                        "SELECT c.session_id,s.status,count(*) AS count FROM agent_session_contents c "
                        "JOIN session_search_sources s ON s.content_id=c.id "
                        "GROUP BY c.session_id,s.status ORDER BY count(*) DESC,c.session_id,s.status"
                    )
                )
                .mappings()
                .all()
            )
            receipt["distribution"] = [dict(row) for row in distribution]
            save()
            assert len({row["session_id"] for row in distribution}) == 10
            assert sum(row["count"] for row in distribution) == 1_000_000
            hot_session = distribution[0]["session_id"]
            assert {
                (row["status"], row["count"])
                for row in distribution
                if row["session_id"] == hot_session
            } == {("indexed", 450_000), ("pending", 450_000)}
        async with engine.connect() as connection:
            connection = await connection.execution_options(
                isolation_level="AUTOCOMMIT"
            )
            for table in TABLES:
                await connection.exec_driver_sql(
                    f'VACUUM (ANALYZE) "{schema}"."{table}"'
                )

        statements = []

        def capture(_connection, _cursor, sql, parameters, _context, _many):
            if sql.lstrip().upper().startswith(("SELECT", "WITH")):
                statements.append((sql, parameters))
                receipt["last_statement"] = {"sql": sql, "parameters": parameters}

        event.listen(engine.sync_engine, "before_cursor_execute", capture)
        try:
            async with engine.connect() as connection:
                await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
                await connection.exec_driver_sql("SET LOCAL statement_timeout='30s'")
                async with AsyncSession(bind=connection) as db:
                    repo = SessionSearchRepository(db)
                    for number in range(1, 7):
                        statements.clear()
                        started = time.perf_counter()
                        rows = await repo.content_coverage(
                            hot_session, EXTRACTOR_VERSION, set()
                        )
                        observation = {
                            "number": number,
                            "seconds": time.perf_counter() - started,
                            "rows": [asdict(row) for row in rows],
                            "statements": list(statements),
                        }
                        receipt["history"].append(observation)
                        save()
                        assert (
                            len(statements) == 1
                        ), "One statement must observe all coverage groups"
                        sql, parameters = statements[0]
                        prepared = (
                            (
                                await connection.exec_driver_sql(
                                    "SELECT name,generic_plans,custom_plans FROM pg_prepared_statements "
                                    "WHERE statement=$1::text",
                                    (sql,),
                                )
                            )
                            .mappings()
                            .one()
                        )
                        observation["prepared"] = dict(prepared)
                        save()
                        assert {tuple(asdict(row).values()) for row in rows} == {
                            (
                                "available",
                                "captured",
                                True,
                                status,
                                False,
                                450_000,
                                450_000 * 1024,
                                450_000,
                                450_000 * 1024,
                                450_000,
                            )
                            for status in ("indexed", "pending")
                        }
                    name = '"' + prepared["name"].replace('"', '""') + '"'
                    raw = (
                        await connection.exec_driver_sql(
                            "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE "
                            + name
                            + "("
                            + execute_arguments(parameters)
                            + ")"
                        )
                    ).scalar_one()
                    receipt["plan"] = json.loads(raw) if isinstance(raw, str) else raw
                    save()
                    receipt["after_explain"] = dict(
                        (
                            await connection.exec_driver_sql(
                                "SELECT name,generic_plans,custom_plans FROM pg_prepared_statements "
                                "WHERE name=$1::text",
                                (prepared["name"],),
                            )
                        )
                        .mappings()
                        .one()
                    )
                    save()
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", capture)
        plan = receipt["plan"][0]["Plan"]
        receipt["visits"] = {
            table: sum(
                (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
                * node["Actual Loops"]
                for node in nodes(plan)
                if node.get("Relation Name") == table
            )
            for table in TABLES
        }
        save()
        assert [
            (item["prepared"]["custom_plans"], item["prepared"]["generic_plans"])
            for item in receipt["history"]
        ] == [(n, 0) for n in range(1, 6)] + [(5, 1)]
        assert (
            receipt["after_explain"]["custom_plans"],
            receipt["after_explain"]["generic_plans"],
        ) == (5, 2)
        assert receipt["visits"][TABLES[0]] <= 900_000 + 2049, receipt["visits"]
        assert receipt["visits"][TABLES[1]] <= 1_000_000 + 2049, receipt["visits"]
        assert receipt["visits"][TABLES[2]] == 0, receipt["visits"]
        assert plan.get("Temp Read Blocks", 0) == 0, receipt_path
        assert plan.get("Temp Written Blocks", 0) == 0, receipt_path
    except BaseException:
        failed = True
        receipt["error"] = traceback.format_exc()
        save()
        raise
    finally:
        try:
            await engine.dispose()
            if created:
                async with admin_engine.begin() as connection:
                    for table in reversed(TABLES):
                        await connection.exec_driver_sql(
                            f'DROP TABLE "{schema}"."{table}"'
                        )
                    await connection.exec_driver_sql(f'DROP SCHEMA "{schema}"')
            receipt["cleanup"] = (
                "owned schema removed" if created else "schema creation not committed"
            )
        except BaseException:
            receipt["cleanup_error"] = traceback.format_exc()
            if not failed:
                raise
        finally:
            save()
