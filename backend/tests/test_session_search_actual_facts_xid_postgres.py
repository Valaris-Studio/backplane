# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Actual facts xid values, application fallback and ordinary prepared execution.

A fresh owned database is required. No target EXPLAIN precedes the eight plain
calls. Natural generic/parallel proof is reported separately from semantics.
"""

import asyncio
from dataclasses import asdict, astuple
import hashlib
import json
import os
import time
import uuid

import pytest
from sqlalchemy import event, func, literal, select, text, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.schemas.session_search import SessionSearchRequest
from app.services.session_search import SessionSearchService
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.conftest import (
    _empty_iap_claims_cache as claims_cache_fixture,
    _integrations_token_key as integrations_key_fixture,
    content_storage as storage_fixture,
)
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_index_migration_postgres import (
    migration_database as index_migration_database_fixture,
)
from tests.test_session_search_latency_postgres import (
    original_eligible_totals,
    seed_pending_contents,
)
from tests.test_session_search_metadata_reuse_postgres import capture_coverage_fallback
from tests.test_session_search_postgres import pg_inline, receipt_path

migration_database = index_migration_database_fixture
paused_object_indexing = pause_processor_fixture
content_storage = storage_fixture
_empty_iap_claims_cache = claims_cache_fixture
_integrations_token_key = integrations_key_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
BODY = (b"leader needle " + b"retained body " * 100)[:1024]
BULK_COUNT = 100_000
SEQUENCE = ("hot", "hot", "hot", "hot", "hot", "tiny", "hot", "hot")
SCOPE = SearchScope(EXTRACTOR_VERSION)
GETTER = "public.session_search_leader_xid_if_assigned()"


def preserve(tmp_path, name, value):
    path = receipt_path(tmp_path, "actual-facts-" + name + ".json")
    with path.open("x") as output:
        json.dump(value, output, indent=2, default=str)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


@pytest.fixture
async def pg(migration_database, monkeypatch, tmp_path):
    # Prepared-plan selection must not inherit another test's relation history.
    await (await migration_database.cli("upgrade", "head")).finish()
    async with migration_database.engine.connect() as connection:
        connection = await connection.execution_options(isolation_level="AUTOCOMMIT")
        name = connection.dialect.identifier_preparer.quote_identifier(
            migration_database.name
        )
        await connection.execute(
            text("ALTER DATABASE " + name + " SET statement_timeout='10s'")
        )
    await migration_database.engine.dispose()
    async with migration_database.engine.connect() as connection:
        await connection.execute(text("SET TRANSACTION READ ONLY"))
        identity = dict(
            (
                await connection.execute(
                    text(
                        "SELECT current_database() AS database,d.oid::bigint AS oid,"
                        "pg_get_userbyid(d.datdba) AS owner,current_user AS role,"
                        "current_setting('data_directory') AS data_directory,"
                        "current_setting('work_mem') AS work_mem,"
                        "current_setting('statement_timeout') AS statement_timeout,"
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
        assert identity["statement_timeout"] == "10s"
        for model in (Content, Source, Chunk):
            assert await connection.scalar(select(func.count()).select_from(model)) == 0
    preserve(tmp_path, "fixture-before", identity)
    with monkeypatch.context() as environment:
        environment.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", migration_database.url)
        fixture = content_postgres_fixture.__wrapped__()
        try:
            yield await fixture.__anext__()
        finally:
            await fixture.aclose()


def coverage(rows):
    return sorted((astuple(row) for row in rows), key=repr)


async def core_observation(db):
    # This direct core call is deliberately a separate SQL statement from facts.
    return dict(
        (
            await db.execute(
                text(
                    "SELECT pg_backend_pid() AS pid, pg_current_snapshot()::text AS snapshot, "
                    "pg_current_xact_id_if_assigned()::text AS xid"
                )
            )
        )
        .mappings()
        .one()
    )


async def prepared_state(connection, sql=None):
    query = (
        "SELECT name,statement,generic_plans,custom_plans FROM pg_prepared_statements"
    )
    if sql is None:
        result = await connection.exec_driver_sql(query + " ORDER BY name")
    else:
        result = await connection.exec_driver_sql(
            query + " WHERE statement=$1::text ORDER BY name", (sql,)
        )
    return [dict(row) for row in result.mappings()]


async def probe_identity(db, name):
    row = (
        (
            await db.execute(
                text(
                    "SELECT current_database() AS database,d.oid::bigint AS database_oid,"
                    "current_user AS role,n.nspname AS schema,n.oid::bigint AS schema_oid,"
                    "c.relname AS name,c.oid::bigint AS oid,c.relkind::text AS kind,c.relpersistence::text AS persistence,"
                    "pg_get_userbyid(c.relowner) AS owner "
                    "FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                    "CROSS JOIN pg_database d WHERE d.datname=current_database() "
                    "AND n.nspname='public' AND c.relname=:name"
                ),
                {"name": name},
            )
        )
        .mappings()
        .one_or_none()
    )
    return None if row is None else dict(row)


async def cleanup_probe(pg, tmp_path, probe):
    receipt = {
        "name": probe["name"],
        "owned": probe.get("owned"),
        "cleanup_cap_seconds": 10,
        "status": "started",
    }
    try:
        if probe.get("owned") is None:
            # CREATE and its ownership read share one transaction. Without an
            # ownership receipt that transaction cannot have committed here.
            receipt["status"] = "no_committed_owned_probe"
            return
        async with asyncio.timeout(10):
            async with pg["factory"].begin() as db:
                await db.execute(text("SET LOCAL statement_timeout='10s'"))
                await db.execute(text("SET LOCAL lock_timeout='2s'"))
                observed = await probe_identity(db, probe["name"])
                receipt["observed_before_lock"] = observed
                if observed is None:
                    # A setup error can roll back CREATE after its OID was read.
                    receipt["status"] = "already_absent"
                    return
                assert observed == probe["owned"], "Probe identity changed; no DROP"
                await db.execute(
                    text(
                        "LOCK TABLE " + probe["qualified"] + " IN ACCESS EXCLUSIVE MODE"
                    )
                )
                locked = await probe_identity(db, probe["name"])
                receipt["observed_under_lock"] = locked
                assert (
                    locked == probe["owned"]
                ), "Probe identity changed while acquiring lock; no DROP"
                await db.execute(text("DROP TABLE " + probe["qualified"] + " RESTRICT"))
                assert await probe_identity(db, probe["name"]) is None
            receipt["status"] = "exact_owned_probe_dropped"
    except BaseException as error:
        receipt.update(status="cleanup_failed", error=repr(error))
        raise
    finally:
        preserve(tmp_path, "probe-cleanup", receipt)


async def build_fixture(pg, tmp_path, probe):
    started = time.perf_counter()
    receipt = {
        "bulk_count": BULK_COUNT,
        "setup_cap_seconds": 30,
        "body_bytes": len(BODY),
    }
    try:
        async with asyncio.timeout(30):
            _, hot_id, acknowledgements = await pg_inline(
                pg, [BODY], native="actual-facts-xid-hot"
            )
            _, tiny_id, _ = await pg_inline(
                pg, [BODY] * 32, native="actual-facts-xid-tiny"
            )
            content_id = uuid.UUID(acknowledgements[0]["content_id"])
            await seed_pending_contents(pg, hot_id, content_id, BULK_COUNT)
            async with pg["factory"].begin() as db:
                source = await db.scalar(
                    select(Source).where(Source.content_id == content_id)
                )
                template = await db.scalar(
                    select(Chunk).where(Chunk.source_id == source.id)
                )
                values = {
                    column.name: getattr(template, column.name)
                    for column in Chunk.__table__.columns
                }
                columns = list(values)
                replacements = {
                    "id": "md5('actual-facts-xid-chunk:' || s.id::text)::uuid",
                    "session_id": "s.session_id",
                    "source_id": "s.id",
                    "sort_order": "c.source_order",
                }
                projection = [replacements.get(name, ":" + name) for name in columns]
                await db.execute(
                    text(
                        "INSERT INTO session_search_chunks (" + ",".join(columns) + ") "
                        "SELECT "
                        + ",".join(projection)
                        + " FROM session_search_sources s "
                        "JOIN agent_session_contents c ON c.id=s.content_id "
                        "WHERE c.session_id=:session AND s.status='pending'"
                    ),
                    {**values, "session": hot_id},
                )
                await db.execute(
                    update(Source)
                    .where(Source.session_id == hot_id)
                    .values(status="indexed", folded_bytes=len(BODY), chunk_count=1)
                )
                assert await probe_identity(db, probe["name"]) is None
                preserve(
                    tmp_path,
                    "probe-create-intent",
                    {
                        "name": probe["name"],
                        "qualified": probe["qualified"],
                        "prior_absence": True,
                        "temporary": False,
                    },
                )
                await db.execute(
                    text(
                        "CREATE TABLE "
                        + probe["qualified"]
                        + " (id integer PRIMARY KEY)"
                    )
                )
                probe["owned"] = await probe_identity(db, probe["name"])
                assert probe["owned"] is not None
                assert (
                    probe["owned"]["kind"] == "r"
                    and probe["owned"]["persistence"] == "p"
                )
                assert probe["owned"]["schema"] == "public"
                assert probe["owned"]["owner"] == probe["owned"]["role"]
                preserve(tmp_path, "probe-owner", probe["owned"])
            # Statistics are measured configuration inputs, not a target warmup.
            # No VACUUM or facts call occurs in setup.
            async with pg["factory"].begin() as db:
                for table in (
                    "agent_session_contents",
                    "session_search_sources",
                    "session_search_chunks",
                ):
                    await db.execute(text("ANALYZE " + table))
            sessions = {"hot": hot_id, "tiny": tiny_id}
            oracles = {}
            async with pg["factory"].begin() as db:
                await db.execute(text("SET TRANSACTION READ ONLY"))
                repo = SessionSearchRepository(db)
                for label, session_id in sessions.items():
                    count = BULK_COUNT + 1 if label == "hot" else 32
                    totals = await original_eligible_totals(repo, session_id, SCOPE)
                    rows = await repo.content_coverage(
                        session_id, EXTRACTOR_VERSION, set()
                    )
                    assert totals == (count, count * len(BODY))
                    assert sum(row.count for row in rows) == count
                    assert all(row.index_status == "indexed" for row in rows)
                    oracles[label] = {"totals": totals, "coverage": coverage(rows)}
                assert (
                    await db.scalar(text("SELECT count(*) FROM " + probe["qualified"]))
                    == 0
                )
            receipt.update(sessions=sessions, oracles=oracles, status="setup_pass")
            return sessions, oracles
    except BaseException as error:
        receipt.update(status="setup_failed", error=repr(error))
        raise
    finally:
        receipt["seconds"] = time.perf_counter() - started
        preserve(tmp_path, "fixture", receipt)


def prepared_literal(value):
    value_type = None
    if not isinstance(value, (str, int, type(None))):
        # asyncpg's UUID is not SQLAlchemy's inferred stdlib UUID type.
        # All other bound values in this source-pinned query are primitives.
        value = uuid.UUID(str(value))
        value_type = postgresql.UUID(as_uuid=True)
    return str(
        literal(value, type_=value_type).compile(
            dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
        )
    )


def plan_observations(root):
    nodes = []

    def walk(node, path, below_gather=False):
        nodes.append({"path": path, "below_gather": below_gather, "node": node})
        below_gather = below_gather or node["Node Type"] in {"Gather", "Gather Merge"}
        for index, child in enumerate(node.get("Plans", [])):
            walk(child, path + "." + str(index), below_gather)

    walk(root, "root")
    projections = [
        {
            "path": item["path"],
            "below_gather": item["below_gather"],
            "rows": item["node"].get("Actual Rows"),
            "loops": item["node"].get("Actual Loops"),
            "output": item["node"].get("Output"),
        }
        for item in nodes
        if any(
            "session_search_leader_xid_if_assigned()" in value
            for value in item["node"].get("Output", [])
        )
    ]
    gathers = [
        {
            "path": item["path"],
            "planned": item["node"].get("Workers Planned", 0),
            "launched": item["node"].get("Workers Launched", 0),
            "loops": item["node"].get("Actual Loops", 0),
        }
        for item in nodes
        if item["node"]["Node Type"] in {"Gather", "Gather Merge"}
    ]
    return {"getter_projections": projections, "gathers": gathers}


@pytest.mark.timeout(290)
async def test_actual_facts_keep_current_xid_across_natural_prepared_reuse_and_own_writes(
    pg, monkeypatch, tmp_path
):
    receipt = {
        "status": "started",
        "sequence": SEQUENCE,
        "plain_call_count": 8,
        "target_explain_before_eight_calls": False,
        "qualification": "Actual-query semantics and natural-plan control only",
    }
    probe_name = "actual_facts_xid_probe_" + uuid.uuid4().hex
    probe = {"name": probe_name, "qualified": 'public."' + probe_name + '"'}
    receipt["probe_name"] = probe_name
    try:
        sessions, oracles = await build_fixture(pg, tmp_path, probe)
        engine = pg["factory"].kw["bind"]
        async with engine.connect() as connection:
            async with AsyncSession(bind=connection, expire_on_commit=False) as db:
                await db.begin()
                await db.execute(
                    text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                )
                await db.execute(text("SET LOCAL statement_timeout='10s'"))
                initial = await core_observation(db)
                assert initial["xid"] is None
                pid = initial["pid"]
                receipt["identity"] = dict(
                    (
                        await db.execute(
                            text(
                                "SELECT current_database() AS database,current_user AS role,pg_backend_pid() AS pid,"
                                "current_setting('server_version_num') AS version,current_setting('data_directory') AS data_directory"
                            )
                        )
                    )
                    .mappings()
                    .one()
                )
                assert receipt["identity"]["pid"] == pid
                settings = [
                    dict(row)
                    for row in (
                        await db.execute(
                            text(
                                "SELECT name,setting,boot_val,source FROM pg_settings WHERE category LIKE 'Query Tuning%' "
                                "OR name IN ('work_mem','hash_mem_multiplier','max_parallel_workers','max_worker_processes') ORDER BY name"
                            )
                        )
                    ).mappings()
                ]
                assert (
                    next(row for row in settings if row["name"] == "work_mem")[
                        "setting"
                    ]
                    == "65536"
                )
                assert all(
                    row["setting"] == row["boot_val"]
                    for row in settings
                    if row["name"] != "work_mem"
                )
                receipt["settings"] = settings
                receipt["getter_catalog"] = [
                    dict(row)
                    for row in (
                        await db.execute(
                            text(
                                "SELECT p.oid::bigint,p.proname,p.provolatile,p.proparallel,p.prosecdef,p.proconfig,"
                                "pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
                                "WHERE p.pronargs=0 AND ((n.nspname='public' AND p.proname='session_search_leader_xid_if_assigned') "
                                "OR (n.nspname='pg_catalog' AND p.proname='pg_current_xact_id_if_assigned')) ORDER BY p.proname"
                            )
                        )
                    ).mappings()
                ]
                assert len(receipt["getter_catalog"]) == 2
                outer = db.sync_session.get_transaction()
                shared_sql = None
                prepared_name = None
                observations = []
                assigned_xid = None
                for ordinal, label in enumerate(SEQUENCE, 1):
                    observation = {
                        "ordinal": ordinal,
                        "label": label,
                        "session_id": sessions[label],
                    }
                    preserve(tmp_path, f"plain-{ordinal:02d}-intent", observation)
                    if ordinal == 6:
                        await db.execute(
                            text("INSERT INTO " + probe["qualified"] + " VALUES (1)")
                        )
                    if ordinal == 7:
                        savepoint = await db.begin_nested()
                        await db.execute(
                            text("INSERT INTO " + probe["qualified"] + " VALUES (2)")
                        )
                    if ordinal == 8:
                        rolled_back = await db.begin_nested()
                        await db.execute(
                            text("INSERT INTO " + probe["qualified"] + " VALUES (3)")
                        )
                        await rolled_back.rollback()
                    before = await core_observation(db)
                    observation["core_before"] = before
                    before_prepared = await prepared_state(connection, shared_sql)
                    observation["prepared_before"] = before_prepared
                    statements = []

                    def capture(_connection, _cursor, sql, parameters, _context, _many):
                        statements.append({"sql": sql, "parameters": parameters})

                    repo = SessionSearchRepository(db)
                    event.listen(
                        connection.sync_connection, "before_cursor_execute", capture
                    )
                    started = time.perf_counter()
                    try:
                        totals = await repo.eligible_totals(sessions[label], SCOPE)
                        facts = repo._coverage_reuse.facts
                        observation.update(totals=totals, facts=asdict(facts))
                    except BaseException as error:
                        observation["error"] = repr(error)
                        raise
                    finally:
                        event.remove(
                            connection.sync_connection, "before_cursor_execute", capture
                        )
                        observation.update(
                            seconds=time.perf_counter() - started, statements=statements
                        )
                        preserve(
                            tmp_path, f"plain-{ordinal:02d}-first-sample", observation
                        )
                    assert len(statements) == 1, statements
                    statement = statements[0]
                    sql = statement["sql"]
                    assert sql.count(GETTER) == 1
                    assert "pg_current_xact_id_if_assigned()" not in sql
                    assert sql.count("pg_current_snapshot()") == 1
                    if shared_sql is None:
                        shared_sql = sql
                        assert not [
                            row for row in before_prepared if row["statement"] == sql
                        ]
                        before_target = {"generic_plans": 0, "custom_plans": 0}
                        preserve(
                            tmp_path,
                            "target-sql",
                            {
                                "sql": sql,
                                "sha256": hashlib.sha256(sql.encode()).hexdigest(),
                            },
                        )
                    else:
                        assert (
                            sql == shared_sql
                        ), "Actual SQL identity changed; do not rewrite it or silently force generic reuse"
                        assert len(before_prepared) == 1
                        before_target = before_prepared[0]
                    after_prepared = await prepared_state(connection, shared_sql)
                    assert len(after_prepared) == 1
                    after_target = after_prepared[0]
                    if prepared_name is None:
                        prepared_name = after_target["name"]
                    assert after_target["name"] == prepared_name
                    assert (
                        sum(
                            after_target[k] - before_target[k]
                            for k in ("generic_plans", "custom_plans")
                        )
                        == 1
                    )
                    assert (
                        after_target["generic_plans"] + after_target["custom_plans"]
                        == ordinal
                    )
                    after = await core_observation(db)
                    observation.update(core_after=after, prepared_after=after_prepared)
                    assert before == after and before["pid"] == pid
                    assert before["snapshot"] == initial["snapshot"] == facts.snapshot
                    assert totals == oracles[label]["totals"] == facts.eligible_totals
                    assert coverage(facts.coverage_rows) == oracles[label]["coverage"]
                    assert facts.xid == before["xid"]
                    if ordinal <= 5:
                        assert facts.xid is None
                    else:
                        assert facts.xid is not None
                        assigned_xid = assigned_xid or facts.xid
                        assert facts.xid == assigned_xid
                    if ordinal in (6, 7):
                        fallback = capture_coverage_fallback(monkeypatch, repo)
                        rows = await repo.content_coverage(
                            sessions[label], EXTRACTOR_VERSION, set()
                        )
                        assert (
                            len(fallback) == 1
                            and coverage(rows) == oracles[label]["coverage"]
                        )
                        observation["fallback_calls"] = len(fallback)
                        assert await core_observation(db) == before
                    if ordinal == 7:
                        await savepoint.commit()
                        assert await core_observation(db) == before
                    assert db.sync_session.get_transaction() is outer
                    observations.append(observation)
                    preserve(tmp_path, f"plain-{ordinal:02d}-validated", observation)
                receipt["eight_plain_calls"] = observations
                assert db.sync_session.get_nested_transaction() is None
                assert (
                    await db.scalar(text("SELECT count(*) FROM " + probe["qualified"]))
                    == 2
                )
                # No target EXPLAIN has run before this point. This replay is a
                # ninth execution, never attributed to any first plain timing.
                quoted_name = '"' + prepared_name.replace('"', '""') + '"'
                arguments = ",".join(
                    prepared_literal(value) for value in statements[0]["parameters"]
                )
                explain = (
                    "EXPLAIN (ANALYZE, VERBOSE, BUFFERS, SETTINGS, FORMAT JSON) EXECUTE "
                    + quoted_name
                    + "("
                    + arguments
                    + ")"
                )
                preserve(
                    tmp_path,
                    "replay-intent",
                    {
                        "sql": explain,
                        "target_sql": shared_sql,
                        "parameters": statements[0]["parameters"],
                        "prepared_before": after_prepared,
                    },
                )
                raw_plan = (await connection.exec_driver_sql(explain)).scalar_one()
                plan = json.loads(raw_plan) if isinstance(raw_plan, str) else raw_plan
                replay_prepared = await prepared_state(connection, shared_sql)
                preserve(
                    tmp_path,
                    "replay",
                    {
                        "plan": plan,
                        "prepared_after": replay_prepared,
                        "classification": "Separate execution9 replay, after all8 plain calls",
                    },
                )
                assert (
                    replay_prepared[0]["generic_plans"]
                    + replay_prepared[0]["custom_plans"]
                    == 9
                )
                placement = plan_observations(plan[0]["Plan"])
                receipt["replay_observations"] = placement
                receipt["naturally_generic_with_assigned_xid"] = any(
                    row["prepared_after"][0]["generic_plans"]
                    > row["prepared_before"][0]["generic_plans"]
                    for row in observations[5:]
                )
                receipt["natural_workers_after_own_writes"] = any(
                    row["launched"] > 0 and row["loops"] > 0
                    for row in placement["gathers"]
                )
                assert await core_observation(db) == observations[-1]["core_after"]

                # Preserve the actual eighth-call cache for the rollback check.
                # A separate real service instance tests the complete authorized
                # request on the same Session, transaction, connection and PID.
                request_early = []
                request_fallback = []
                original_eligible = SessionSearchRepository.eligible_totals
                original_coverage_query = (
                    SessionSearchRepository._content_coverage_query
                )

                async def record_early(self, *args, **kwargs):
                    result = await original_eligible(self, *args, **kwargs)
                    request_early.append(
                        {
                            "facts": asdict(self._coverage_reuse.facts),
                            "same_session": self.db is db,
                        }
                    )
                    return result

                def record_fallback(self, *args, **kwargs):
                    request_fallback.append({"same_session": self.db is db})
                    return original_coverage_query(self, *args, **kwargs)

                before_request = await core_observation(db)
                with monkeypatch.context() as patches:
                    patches.setattr(
                        SessionSearchRepository, "eligible_totals", record_early
                    )
                    patches.setattr(
                        SessionSearchRepository,
                        "_content_coverage_query",
                        record_fallback,
                    )
                    page = await SessionSearchService(db).search(
                        pg["workspace_id"],
                        pg["owner_id"],
                        sessions["hot"],
                        SessionSearchRequest(q="leader needle", limit=1),
                    )
                after_request = await core_observation(db)
                request = {
                    "before": before_request,
                    "after": after_request,
                    "early": request_early,
                    "fallback": request_fallback,
                    "page": page.model_dump(mode="json"),
                }
                preserve(tmp_path, "actual-request", request)
                assert (
                    before_request == after_request
                    and before_request["xid"] == assigned_xid
                )
                assert len(request_early) == len(request_fallback) == 1
                assert (
                    request_early[0]["same_session"]
                    and request_fallback[0]["same_session"]
                )
                assert request_early[0]["facts"]["xid"] == assigned_xid
                assert (
                    request_early[0]["facts"]["snapshot"] == before_request["snapshot"]
                )
                assert page.eligible_bytes == oracles["hot"]["totals"][1]
                assert page.coverage.indexed.count == BULK_COUNT + 1
                assert len(page.items) == 1
                assert db.sync_session.get_transaction() is outer

                assert (
                    repo._coverage_reuse is not None
                    and repo._coverage_reuse.facts.xid == assigned_xid
                )
                await db.rollback()
                await db.begin()
                await db.execute(
                    text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                )
                await db.execute(text("SET LOCAL statement_timeout='10s'"))
                fresh_before = await core_observation(db)
                assert fresh_before["pid"] == pid and fresh_before["xid"] is None
                assert db.sync_session.get_transaction() is not outer
                fallback = capture_coverage_fallback(monkeypatch, repo)
                rows = await repo.content_coverage(
                    sessions["hot"], EXTRACTOR_VERSION, set()
                )
                assert (
                    len(fallback) == 1 and coverage(rows) == oracles["hot"]["coverage"]
                )
                assert (
                    await repo.eligible_totals(sessions["hot"], SCOPE)
                    == oracles["hot"]["totals"]
                )
                fresh_facts = repo._coverage_reuse.facts
                fresh_after = await core_observation(db)
                preserve(
                    tmp_path,
                    "rollback-reuse",
                    {
                        "before": fresh_before,
                        "after": fresh_after,
                        "fallback_calls": len(fallback),
                        "facts": asdict(fresh_facts),
                    },
                )
                assert fresh_before == fresh_after
                assert (
                    fresh_facts.xid is None
                    and fresh_facts.snapshot == fresh_before["snapshot"]
                )
                assert (
                    await db.scalar(text("SELECT count(*) FROM " + probe["qualified"]))
                    == 0
                )
                await db.rollback()
                receipt["semantics"] = "PASS"
                projections = placement["getter_projections"]
                receipt["getter_on_leader_once"] = (
                    len(projections) == 1
                    and projections[0]["rows"] == projections[0]["loops"] == 1
                    and not projections[0]["below_gather"]
                )
                receipt["status"] = "semantics_pass_natural_plan_evidence_recorded"
                # Missing natural evidence is an unresolved control, not a
                # semantic failure or permission to force another plan.
                assert receipt["getter_on_leader_once"], placement
                assert receipt[
                    "naturally_generic_with_assigned_xid"
                ], "Semantic checks passed, but natural generic reuse after writes remains UNPROVED"
                assert receipt[
                    "natural_workers_after_own_writes"
                ], "Semantic checks passed, but natural parallel execution after writes remains UNPROVED"
                receipt["status"] = "semantics_and_natural_generic_parallel_pass"
    except BaseException as error:
        receipt["error"] = repr(error)
        raise
    finally:
        # Both measurement contexts have exited, rolling back on any failure,
        # before this separate bounded cleanup transaction obtains its lock.
        try:
            await cleanup_probe(pg, tmp_path, probe)
        except BaseException as error:
            receipt["probe_cleanup_error"] = repr(error)
            if "error" not in receipt:
                raise
        finally:
            preserve(tmp_path, "control-summary", receipt)
