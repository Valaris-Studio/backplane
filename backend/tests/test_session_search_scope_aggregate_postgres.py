# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exact scope aggregation and actual database work on disposable PostgreSQL."""

import asyncio
import json
import re
import uuid
from collections import defaultdict
from contextlib import contextmanager, nullcontext
from copy import deepcopy
from dataclasses import asdict
from decimal import Decimal
from unittest.mock import patch

import pytest
from sqlalchemy import delete, event, literal, select, text, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.models.agent_session import AgentSession, AgentSessionContent as Content
from app.models.kanban.board import Board
from app.models.session_search import SessionSearchSource as Source
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.schemas.session_content import MAX_TEXT_BODY_BYTES
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rich_capture import declaration
from tests.test_session_calls import prompt
from tests.test_session_content_postgres import (
    pg as capture_postgres_fixture,
    _alembic,
    database_url,
    post_batch,
    session_record,
)
from tests.test_session_search_backfill_coverage_cost_postgres import (
    BODY as COST_BODY,
    clone_retained_sources,
    nodes,
    observed_coverage_statement,
)
from tests.test_session_search_postgres import receipt_path

pg = capture_postgres_fixture
pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("content_storage")]
ISOLATIONS = ("READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE")
BODY = "scope café".encode()


@pytest.fixture
async def isolated_scope_pg(monkeypatch, tmp_path, request):
    """A new physical database keeps plan-sensitive fixtures independent."""
    server = make_url(database_url())
    assert server.host in {"127.0.0.1", "localhost", "::1"}
    name = "b01h_scope_" + uuid.uuid4().hex
    output = receipt_path(tmp_path, f"{request.node.name}-database.json")
    assert not output.exists(), "Use a fresh measurement directory"
    observation = {"database": name, "created": False, "dropped": False}
    admin = create_async_engine(
        server, isolation_level="AUTOCOMMIT", hide_parameters=True
    )
    fixture = None
    try:
        async with admin.connect() as connection:
            await connection.execute(
                text(
                    f'CREATE DATABASE "{name}" TEMPLATE template0 '
                    "ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'"
                )
            )
        observation["created"] = True
        scratch = server.set(database=name).render_as_string(hide_password=False)
        _alembic(scratch, "upgrade", "head")
        monkeypatch.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", scratch)
        fixture = capture_postgres_fixture.__wrapped__()
        env = await fixture.__anext__()
        async with env["factory"]() as db:
            observation["identity"] = dict(
                (
                    await db.execute(
                        text(
                            "SELECT current_database() AS database, "
                            "current_setting('server_version') AS server_version, "
                            "current_setting('server_version_num') AS server_version_num, "
                            "version_num AS schema_revision FROM alembic_version"
                        )
                    )
                )
                .mappings()
                .one()
            )
            assert observation["identity"]["database"] == name
            observation["planner_configuration"] = [
                dict(row)
                for row in (
                    await db.execute(
                        text(
                            "SELECT name, setting, reset_val, source FROM pg_settings "
                            "WHERE name LIKE 'enable_%' OR name IN "
                            "('default_statistics_target','work_mem','random_page_cost',"
                            "'seq_page_cost','effective_cache_size','jit',"
                            "'max_parallel_workers_per_gather') ORDER BY name"
                        )
                    )
                ).mappings()
            ]
        env["scope_fixture_observation"] = observation
        yield env
    finally:
        try:
            if fixture is not None:
                await fixture.aclose()
        finally:
            try:
                if observation["created"]:
                    async with admin.connect() as connection:
                        await connection.execute(text(f'DROP DATABASE "{name}"'))
                        observation["dropped"] = not await connection.scalar(
                            text(
                                "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=:name)"
                            ),
                            {"name": name},
                        )
                        assert observation["dropped"]
            finally:
                await admin.dispose()
                output.write_text(json.dumps(observation, indent=2) + "\n")


async def analyze_scope_relations(pg):
    """Ordinary complete statistics after seeding, with no planner overrides."""
    relations = (
        "agent_session_contents",
        "agent_session_events",
        "agent_sessions",
        "session_search_sources",
        "workspace_members",
    )
    async with pg["factory"].begin() as db:
        statistics = {}
        for table in relations:
            await db.execute(text(f"ANALYZE {table}"))
            statistics[table] = dict(
                (
                    await db.execute(
                        text(
                            "SELECT reltuples,relpages, "
                            f"(SELECT count(*) FROM {table}) AS actual_rows "
                            "FROM pg_class WHERE oid=to_regclass(:name)"
                        ),
                        {"name": table},
                    )
                )
                .mappings()
                .one()
            )
        pg["scope_fixture_observation"]["analyzed_relations"] = statistics
        pg["scope_fixture_observation"]["source_heap_extents"] = [
            await db.scalar(
                text(
                    "SELECT ctid::text AS heap_location FROM session_search_sources "
                    f"ORDER BY session_search_sources.ctid {order} LIMIT 1"
                )
            )
            for order in ("ASC", "DESC")
        ]


@contextmanager
def observed_aggregate(db):
    """Keep the returned rows while counting all SQL during the repository call."""
    observation = {"sql": [], "raw_results": []}
    bound = db.get_bind()
    engine = getattr(bound, "engine", bound)
    original_execute = db.execute

    def record_sql(_connection, _cursor, sql, parameters, _context, _many):
        observation["sql"].append((sql, parameters))

    async def execute(*args, **kwargs):
        result = await original_execute(*args, **kwargs)
        frozen = result.freeze()
        rows = []
        for row in frozen().all():
            values = []
            for value in row:
                if isinstance(value, Decimal):
                    assert value.is_finite() and value == value.to_integral_value()
                    value = int(value)
                values.append(value)
            rows.append(values)
        observation["raw_results"].append(rows)
        return frozen()

    event.listen(engine, "before_cursor_execute", record_sql)
    try:
        with patch.object(db, "execute", execute):
            yield observation
    finally:
        event.remove(engine, "before_cursor_execute", record_sql)


def assert_six_categories(observation, *, has_content=True):
    assert len(observation["sql"]) == 1
    assert len(observation["raw_results"]) == 1
    parts = [row[0] for row in observation["raw_results"][0]]
    expected = {
        "content",
        "event",
        "excluded_content",
        "excluded_event",
        "children",
        "unresolved_metadata",
    }
    if not has_content:
        expected.remove("content")
    assert set(parts) == expected
    assert all(parts.count(part) == 1 for part in expected - {"content"})


async def same_transaction_plan(db, statement):
    connection = await db.connection()
    raw = await connection.get_raw_connection()
    sql, parameters = statement
    result = await raw.driver_connection.fetchval(
        "EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) " + sql, *parameters
    )
    return result[0]


async def prepared_entries(db, statement):
    return [
        dict(row)
        for row in (
            await db.execute(
                text(
                    "SELECT name, generic_plans, custom_plans "
                    "FROM pg_prepared_statements WHERE statement=:statement"
                ),
                {"statement": statement},
            )
        ).mappings()
    ]


async def predicate_locks(db):
    return [
        dict(row)
        for row in (
            await db.execute(
                text(
                    "SELECT locktype, relation::regclass::text AS relation, page, tuple "
                    "FROM pg_locks WHERE pid=pg_backend_pid() AND mode='SIReadLock' "
                    "ORDER BY relation, page, tuple"
                )
            )
        ).mappings()
    ]


async def cached_transaction_plan(db, statement, prepared):
    assert len(prepared) == 1
    name = prepared[0]["name"]
    assert re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", name)
    sql, parameters = statement
    assert len(parameters) <= 64
    assert all(
        value is None or isinstance(value, (str, int, bool)) for value in parameters
    )
    assert all(not isinstance(value, str) or len(value) <= 256 for value in parameters)
    arguments = ",".join(
        str(
            literal(value).compile(
                dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}
            )
        )
        for value in parameters
    )
    connection = await db.connection()
    raw = await connection.get_raw_connection()
    result = await raw.driver_connection.fetchval(
        f'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) EXECUTE "{name}" ({arguments})'
    )
    return result[0]


def source_work(plan):
    accesses = [
        node
        for node in nodes(plan["Plan"])
        if node.get("Relation Name") == "session_search_sources"
    ]
    return sum(max(0, node["Actual Loops"] - 1) for node in accesses)


def assert_inactive_sources_unread(plan):
    # These populated fixtures make the inactive gates return zero rows.
    # Generic plans hide setting names behind parameters; inspect every gate.
    # A legitimately pruned branch needs no retained source node.
    inactive = [
        node
        for node in nodes(plan["Plan"])
        if "One-Time Filter" in node and node.get("Actual Rows") == 0
    ]
    for gate in inactive:
        for node in nodes(gate):
            if node.get("Relation Name") == "session_search_sources":
                assert node["Actual Loops"] == 0
                assert node["Actual Rows"] == 0
                assert node.get("Shared Hit Blocks", 0) == 0
                assert node.get("Shared Read Blocks", 0) == 0
    return len(inactive)


def test_inactive_generic_gate_rejects_unexpected_source_work():
    plan = {
        "Plan": {
            "Node Type": "Result",
            "One-Time Filter": "(current_setting(($6)::text) = ($7)::text)",
            "Actual Loops": 1,
            "Actual Rows": 0,
            "Plans": [
                {
                    "Node Type": "Index Scan",
                    "Relation Name": "session_search_sources",
                    "Actual Loops": 0,
                    "Actual Rows": 0,
                    "Shared Hit Blocks": 0,
                    "Shared Read Blocks": 0,
                }
            ],
        }
    }
    for metric in (
        "Actual Loops",
        "Actual Rows",
        "Shared Hit Blocks",
        "Shared Read Blocks",
    ):
        unexpected_work = deepcopy(plan)
        unexpected_work["Plan"]["Plans"][0][metric] = 1
        with pytest.raises(AssertionError):
            assert_inactive_sources_unread(unexpected_work)
    assert assert_inactive_sources_unread(plan) == 1
    assert (
        assert_inactive_sources_unread(
            {"Plan": {"Node Type": "Result", "Actual Loops": 1, "Actual Rows": 8193}}
        )
        == 0
    )


async def aggregate(db):
    return await SessionSearchBackfillRepository(db).scope_aggregate(
        extractor_version=EXTRACTOR_VERSION,
        backend="local",
        max_body_bytes=MAX_TEXT_BODY_BYTES,
    )


def normalized(value):
    result = asdict(value) if not isinstance(value, dict) else dict(value)
    result["contents"] = sorted(
        result["contents"], key=lambda row: json.dumps(row, sort_keys=True)
    )
    return result


def empty_aggregate(**overrides):
    return {
        "contents": [],
        "events_stored": 0,
        "events_indexed": 0,
        "events_indexed_bytes": 0,
        "owner_not_member": 0,
        "child_sessions": 0,
        "unresolved_metadata": 0,
        **overrides,
    }


def content_row(status, count=1, *, body=BODY):
    return {
        "state": "available",
        "coverage": "captured",
        "is_text": True,
        "index_status": status,
        "unverified": False,
        "count": count,
        "stored_bytes": len(body) * count,
        "stored_known": count,
        "original_bytes": len(body) * count,
        "original_known": count,
    }


async def seed_content(pg):
    response = await post_batch(
        pg,
        [
            session_record(
                pg,
                "scope-" + uuid.uuid4().hex,
                [declaration(BODY)],
            )
        ],
    )
    assert response["rejected"] == []
    return uuid.UUID(response["contents"][0]["content_id"])


async def bounded_transaction(db, isolation):
    transaction = await db.begin()
    await db.execute(text(f"SET TRANSACTION ISOLATION LEVEL {isolation}"))
    await db.execute(text("SET LOCAL statement_timeout='8s'"))
    await db.execute(text("SET LOCAL lock_timeout='3s'"))
    return transaction


async def test_scope_aggregate_avoids_repeated_source_probes(
    isolated_scope_pg, tmp_path
):
    pg = isolated_scope_pg
    additional = 8192
    total = additional + 1
    await clone_retained_sources(pg, contents=additional, indexed=additional)
    await analyze_scope_relations(pg)
    expected = empty_aggregate(contents=[content_row("indexed", total, body=COST_BODY)])
    async with pg["factory"]() as db:
        with observed_aggregate(db) as observed:
            actual = normalized(await aggregate(db))
        assert_six_categories(observed)
        plan = await same_transaction_plan(db, observed["sql"][0])
    assert actual == normalized(expected)
    assert_inactive_sources_unread(plan)
    source_accesses = [
        node
        for node in nodes(plan["Plan"])
        if node.get("Relation Name") == "session_search_sources"
    ]
    repeated_probes = sum(max(0, node["Actual Loops"] - 1) for node in source_accesses)
    observation = {
        "fixture": {
            "additional_contents": additional,
            "additional_sources": additional,
            "total_contents": total,
            "total_sources": total,
        },
        "aggregate": actual,
        "expected": normalized(expected),
        "plan": plan,
        "repeated_source_probes": repeated_probes,
        "source_accesses": [
            {
                key: node.get(key)
                for key in (
                    "Node Type",
                    "Actual Rows",
                    "Actual Loops",
                    "Rows Removed by Filter",
                    "Shared Hit Blocks",
                    "Shared Read Blocks",
                    "Temp Read Blocks",
                    "Temp Written Blocks",
                )
            }
            for node in source_accesses
        ],
    }
    output = receipt_path(tmp_path, "scope-aggregate-actual-work.json")
    assert not output.exists(), "Use a fresh measurement directory"
    output.write_text(json.dumps(observation, indent=2) + "\n")
    # Allow repeated whole-relation accesses across branches/workers, but not
    # one source lookup per content. No join algorithm or latency is mandated.
    assert repeated_probes <= 32, observation["source_accesses"]


async def test_scope_aggregate_preserves_exact_groups_and_all_six_parts(pg):
    cases = [
        {"status": "indexed"},
        {"status": "pending", "source": {"status": "pending"}},
        {"status": "unavailable", "source": {"status": "unavailable"}},
        {"status": "not_text", "source": {"status": "not_text"}},
        {"status": None, "missing_source": True},
        {"status": None, "source": {"extractor_version": "older-extractor"}},
        {"status": None, "source": {"source_digest": "0" * 64}},
        {"status": None, "content": {"sha256": None}, "untrusted": True},
        {
            "status": "indexed",
            "content": {"byte_count": None, "original_byte_count": None},
            "untrusted": True,
        },
        {
            "status": "indexed",
            "content": {"byte_count": None, "original_byte_count": 73},
            "untrusted": True,
        },
        {"status": "indexed", "content": {"original_byte_count": 91}},
        {
            "status": "indexed",
            "content": {"media_type": "image/png", "inline_text": None},
        },
        {
            "status": "pending",
            "content": {
                "state": "pending",
                "coverage": "not_yet_uploaded",
                "inline_text": None,
            },
            "source": {"status": "pending"},
        },
        {
            "status": None,
            "content": {
                "state": "recorded",
                "coverage": "withheld_by_policy",
                "inline_text": None,
                "sha256": None,
                "byte_count": None,
                "original_byte_count": 53,
            },
        },
        {
            "status": "indexed",
            "content": {
                "state": "recorded",
                "coverage": "expired",
                "inline_text": None,
            },
        },
        {
            "status": "indexed",
            "content": {"byte_count": len(BODY) + 1},
            "untrusted": True,
        },
        {
            "status": "indexed",
            "content": {
                "inline_text": None,
                "storage_backend": "gcs",
                "storage_key": "synthetic-body",
            },
            "untrusted": True,
        },
        {
            "status": "indexed",
            "content": {
                "inline_text": None,
                "storage_backend": "local",
                "storage_key": None,
            },
            "untrusted": True,
        },
        {
            "status": "indexed",
            "content": {
                "inline_text": None,
                "storage_backend": "local",
                "storage_key": "synthetic-body",
                "byte_count": MAX_TEXT_BODY_BYTES + 1,
            },
            "untrusted": True,
        },
    ]
    parent = session_record(pg, "scope-parent", [declaration(BODY) for _ in cases])
    parent["events"] = [prompt(index, "scope event") for index in (1, 2)]
    child = session_record(
        pg, "scope-child", [], parent_native_session_id="scope-parent"
    )
    child["events"] = [prompt(3, "scope child event")]
    child.pop("capture_generation")
    response = await post_batch(pg, [parent, child])
    assert response["rejected"] == []
    identities = [uuid.UUID(item["content_id"]) for item in response["contents"]]
    assert len(identities) == len(cases)
    grouped = defaultdict(
        lambda: {
            "count": 0,
            "stored_bytes": 0,
            "stored_known": 0,
            "original_bytes": 0,
            "original_known": 0,
        }
    )
    other_fixture = capture_postgres_fixture.__wrapped__()
    other = await other_fixture.__anext__()
    try:
        excluded = session_record(other, "scope-excluded", [declaration(BODY)])
        excluded["events"] = [prompt(1, "excluded event")]
        assert (await post_batch(other, [excluded]))["rejected"] == []
        async with pg["factory"].begin() as db:
            for content_id, case in zip(identities, cases, strict=True):
                changes = case.get("content", {})
                if changes:
                    await db.execute(
                        update(Content)
                        .where(Content.id == content_id)
                        .values(**changes)
                    )
                if case.get("missing_source"):
                    await db.execute(
                        delete(Source).where(Source.content_id == content_id)
                    )
                elif case.get("source"):
                    await db.execute(
                        update(Source)
                        .where(Source.content_id == content_id)
                        .values(**case["source"])
                    )
                key = (
                    changes.get("state", "available"),
                    changes.get("coverage", "captured"),
                    changes.get("media_type", "text/plain") == "text/plain",
                    case["status"],
                )
                stored = changes.get("byte_count", len(BODY))
                original = changes.get("original_byte_count")
                original = stored if original is None else original
                row = grouped[key]
                row["count"] += 1
                row["stored_bytes"] += stored or 0
                row["stored_known"] += int(stored is not None)
                row["original_bytes"] += original or 0
                row["original_known"] += int(original is not None)
            events = list(
                await db.scalars(
                    select(Source)
                    .where(
                        Source.event_id.is_not(None),
                        Source.session_id.in_(
                            select(AgentSession.id).where(
                                AgentSession.workspace_id == pg["workspace_id"],
                                AgentSession.owner_id == pg["owner_id"],
                            )
                        ),
                    )
                    .order_by(Source.id)
                )
            )
            assert len(events) == 3
            events[0].byte_count = 17
            events[0].source_digest = "0" * 64
            events[1].extractor_version = "older-extractor"
            events[2].status = "pending"
            await db.execute(
                delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == other["workspace_id"],
                    WorkspaceMember.user_id == other["owner_id"],
                )
            )
            db.add(
                WorkspaceMember(
                    workspace_id=pg["workspace_id"],
                    user_id=other["owner_id"],
                    role=WorkspaceRole.member,
                )
            )
        expected = empty_aggregate(
            contents=[
                {
                    "state": key[0],
                    "coverage": key[1],
                    "is_text": key[2],
                    "index_status": key[3],
                    "unverified": False,
                    **counts,
                }
                for key, counts in grouped.items()
            ],
            events_stored=3,
            events_indexed=1,
            events_indexed_bytes=17,
            owner_not_member=2,
            child_sessions=1,
            unresolved_metadata=sum(bool(case.get("untrusted")) for case in cases),
        )
        async with pg["factory"]() as db:
            with observed_aggregate(db) as observed:
                assert normalized(await aggregate(db)) == normalized(expected)
            assert_six_categories(observed)
        async with pg["factory"].begin() as db:
            await db.execute(
                delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == pg["workspace_id"],
                    WorkspaceMember.user_id == pg["owner_id"],
                )
            )
        async with pg["factory"]() as db:
            assert normalized(await aggregate(db)) == empty_aggregate(
                owner_not_member=len(cases) + 5
            )
        async with pg["factory"].begin() as db:
            db.add(
                WorkspaceMember(
                    workspace_id=pg["workspace_id"],
                    user_id=pg["owner_id"],
                    role=WorkspaceRole.owner,
                )
            )
        async with pg["factory"]() as db:
            assert normalized(await aggregate(db)) == normalized(expected)
    finally:
        await other_fixture.aclose()


@pytest.mark.parametrize("isolation", ISOLATIONS)
@pytest.mark.parametrize("autoflush", [True, False], ids=["autoflush", "no_autoflush"])
@pytest.mark.parametrize("mutation", ["source_status", "new_source"])
async def test_scope_aggregate_preserves_caller_autoflush_and_rollback(
    pg,
    tmp_path,
    isolation,
    autoflush,
    mutation,
):
    content_id = await seed_content(pg)
    baseline_status = "indexed" if mutation == "source_status" else None
    async with pg["factory"].begin() as db:
        source = await db.scalar(select(Source).where(Source.content_id == content_id))
        template = {
            column.name: getattr(source, column.name)
            for column in Source.__table__.columns
        }
        if mutation == "new_source":
            await db.delete(source)
    output = receipt_path(
        tmp_path, f"scope-orm-{isolation.replace(' ', '-')}-{mutation}-{autoflush}.json"
    )
    assert not output.exists(), "Use a fresh measurement directory"
    observation = {"isolation": isolation, "autoflush": autoflush, "mutation": mutation}
    async with pg["factory"]() as db:
        transaction = await bounded_transaction(db, isolation)
        try:
            if mutation == "source_status":
                source = await db.scalar(
                    select(Source).where(Source.content_id == content_id)
                )
                source.status = "pending"
            else:
                source = Source(
                    **{
                        **template,
                        "id": uuid.uuid4(),
                        "status": "pending",
                        "chunk_count": 0,
                    }
                )
                db.add(source)
            with observed_coverage_statement(pg) as statements:
                with nullcontext() if autoflush else db.no_autoflush:
                    observed = normalized(await aggregate(db))
            observation.update(
                before_explicit_flush=observed,
                query_count=len(statements),
                pending_orm=source in db.dirty or source in db.new,
                transaction_active=transaction.is_active and db.in_transaction(),
            )
            output.write_text(json.dumps(observation, indent=2) + "\n")
            expected_status = "pending" if autoflush else baseline_status
            assert observed == empty_aggregate(contents=[content_row(expected_status)])
            assert observation["pending_orm"] is not autoflush
            assert observation["transaction_active"]
            assert len(statements) == 1
            await db.flush()
            assert normalized(await aggregate(db)) == empty_aggregate(
                contents=[content_row("pending")]
            )
            async with pg["factory"]() as outsider:
                assert normalized(await aggregate(outsider)) == empty_aggregate(
                    contents=[content_row(baseline_status)]
                )
        finally:
            await db.rollback()
    async with pg["factory"]() as fresh:
        assert normalized(await aggregate(fresh)) == empty_aggregate(
            contents=[content_row(baseline_status)]
        )


@pytest.mark.parametrize("isolation", ISOLATIONS)
@pytest.mark.parametrize(
    "writer_commits", [True, False], ids=["writer-commit", "writer-rollback"]
)
async def test_scope_aggregate_preserves_successful_overlapping_transactions(
    pg,
    tmp_path,
    isolation,
    writer_commits,
):
    content_id = await seed_content(pg)
    original = empty_aggregate(contents=[content_row("indexed")])
    changed = empty_aggregate(contents=[content_row("pending")])
    observations = {"isolation": isolation, "writer_commits": writer_commits}
    output = receipt_path(
        tmp_path, f"scope-overlap-{isolation.replace(' ', '-')}-{writer_commits}.json"
    )
    assert not output.exists(), "Use a fresh measurement directory"
    async with asyncio.timeout(30):
        async with pg["factory"]() as reader, pg["factory"]() as writer:
            reader_tx = await bounded_transaction(reader, isolation)
            writer_tx = await bounded_transaction(writer, isolation)
            try:
                observations["before"] = normalized(await aggregate(reader))
                assert observations["before"] == original
                await writer.execute(
                    update(Source)
                    .where(Source.content_id == content_id)
                    .values(status="pending")
                )
                if writer_commits:
                    await writer_tx.commit()
                else:
                    await writer_tx.rollback()
                observations["after_writer"] = normalized(await aggregate(reader))
                expected = (
                    changed
                    if writer_commits and isolation == "READ COMMITTED"
                    else original
                )
                assert observations["after_writer"] == expected
                assert reader_tx.is_active
                # The reader also writes, but creates no dependency cycle:
                # the source writer never reads this independent board marker.
                await reader.execute(
                    update(Board)
                    .where(Board.workspace_id == pg["workspace_id"])
                    .values(name="scope read committed")
                )
                await reader_tx.commit()
                observations["both_transactions_finished"] = True
            finally:
                if reader_tx.is_active:
                    await reader_tx.rollback()
                if writer_tx.is_active:
                    await writer_tx.rollback()
                output.write_text(json.dumps(observations, indent=2) + "\n")
    async with pg["factory"]() as fresh:
        assert normalized(await aggregate(fresh)) == (
            changed if writer_commits else original
        )


async def test_scope_aggregate_preserves_serializable_nonmember_source_schedule(
    isolated_scope_pg, tmp_path
):
    """Unobserved foreign Source writes must not create an SSI dependency."""
    pg = isolated_scope_pg
    count = 4096
    output = receipt_path(tmp_path, "scope-serializable-nonmember-source.json")
    assert not output.exists(), "Use a fresh measurement directory"
    observation = {"member_contents": count, "nonmember_contents": count}
    other_fixture = capture_postgres_fixture.__wrapped__()
    other = await other_fixture.__anext__()

    async def clone_metadata(db, model, identity, overrides):
        columns = [column.name for column in model.__table__.columns]
        projection = ",".join(overrides.get(name, f't."{name}"') for name in columns)
        names = ",".join(f'"{name}"' for name in columns)
        await db.execute(
            text(
                f"INSERT INTO {model.__tablename__} ({names}) "
                f"SELECT {projection} FROM {model.__tablename__} t "
                "CROSS JOIN generate_series(1, :count) g WHERE t.id = :identity "
                "ORDER BY g"
            ),
            {"count": count, "identity": identity},
        )

    def ordered_id(prefix):
        return f"('{prefix}-0000-0000-0000-' || lpad(to_hex(g),12,'0'))::uuid"

    try:
        foreign_seed = await seed_content(other)
        async with pg["factory"].begin() as db:
            source_id = await db.scalar(
                select(Source.id).where(Source.content_id == foreign_seed)
            )
            await clone_metadata(
                db,
                Content,
                foreign_seed,
                {
                    "id": ordered_id("10000000"),
                    "content_key": "md5('foreign' || g::text) || md5(g::text)",
                    "source_order": "g",
                },
            )
            await clone_metadata(
                db,
                Source,
                source_id,
                {
                    "id": ordered_id("20000000"),
                    "content_id": ordered_id("10000000"),
                },
            )
            await db.execute(delete(Content).where(Content.id == foreign_seed))
            await db.execute(
                delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == other["workspace_id"],
                    WorkspaceMember.user_id == other["owner_id"],
                )
            )
        member_seed = await seed_content(pg)
        member_content = uuid.UUID("f0000000-0000-0000-0000-000000000001")
        member_source = uuid.UUID("f1000000-0000-0000-0000-000000000001")
        foreign_source = uuid.UUID("20000000-0000-0000-0000-000000000800")
        async with pg["factory"].begin() as db:
            source = await db.scalar(
                select(Source).where(Source.content_id == member_seed)
            )
            template = {
                column.name: getattr(source, column.name)
                for column in Source.__table__.columns
            }
            await clone_metadata(
                db,
                Content,
                member_seed,
                {
                    "id": ordered_id("f0000000"),
                    "content_key": "md5('member' || g::text) || md5(g::text)",
                    "source_order": "g",
                },
            )
            await db.execute(delete(Content).where(Content.id == member_seed))
            db.add(
                Source(
                    **{**template, "id": member_source, "content_id": member_content}
                )
            )
        await analyze_scope_relations(pg)
        async with pg["factory"].begin() as db:
            rows = (
                await db.execute(
                    text(
                        "SELECT id, ctid::text AS heap_location "
                        "FROM session_search_sources WHERE id IN (:member, :foreign)"
                    ),
                    {"member": member_source, "foreign": foreign_source},
                )
            ).mappings()
            locations = {str(row["id"]): row["heap_location"] for row in rows}
            observation["source_heap_locations"] = locations
            assert len(locations) == 2
            assert (
                locations[str(member_source)].split(",")[0]
                != locations[str(foreign_source)].split(",")[0]
            )
            board_id = await db.scalar(
                select(Board.id).where(Board.workspace_id == pg["workspace_id"])
            )
            assert board_id is not None
        expected = normalized(
            empty_aggregate(
                contents=[content_row("indexed"), content_row(None, count - 1)],
                owner_not_member=count,
            )
        )
        engine = pg["factory"].kw["bind"]
        async with asyncio.timeout(30):
            async with engine.connect() as reader_connection, pg["factory"]() as writer:
                async with AsyncSession(
                    bind=reader_connection, expire_on_commit=False
                ) as reader:
                    observation["warmups"] = []
                    for mode in ("READ COMMITTED", "REPEATABLE READ"):
                        warm_tx = await bounded_transaction(reader, mode)
                        try:
                            identity = dict(
                                (
                                    await reader.execute(
                                        text(
                                            "SELECT pg_backend_pid() AS backend_pid, "
                                            "current_setting('transaction_isolation') AS actual_isolation"
                                        )
                                    )
                                )
                                .mappings()
                                .one()
                            )
                            with observed_aggregate(reader) as warm:
                                assert normalized(await aggregate(reader)) == expected
                            assert_six_categories(warm)
                            observation["warmups"].append(
                                {
                                    **identity,
                                    "prepared": await prepared_entries(
                                        reader, warm["sql"][0][0]
                                    ),
                                }
                            )
                        finally:
                            await warm_tx.rollback()
                    reader_tx = await bounded_transaction(reader, "SERIALIZABLE")
                    writer_tx = await bounded_transaction(writer, "SERIALIZABLE")
                    try:
                        identity = dict(
                            (
                                await reader.execute(
                                    text(
                                        "SELECT pg_backend_pid() AS backend_pid, "
                                        "current_setting('transaction_isolation') AS actual_isolation"
                                    )
                                )
                            )
                            .mappings()
                            .one()
                        )
                        observation.update(identity)
                        with observed_aggregate(reader) as observed:
                            observation["aggregate"] = normalized(
                                await aggregate(reader)
                            )
                        assert observation["aggregate"] == expected
                        assert_six_categories(observed)
                        observation["raw_aggregate"] = observed["raw_results"][0]
                        observation["reader_predicate_locks"] = await predicate_locks(
                            reader
                        )
                        statement = observed["sql"][0]
                        observation["prepared_before_plan"] = await prepared_entries(
                            reader, statement[0]
                        )
                        observation["plan"] = await cached_transaction_plan(
                            reader, statement, observation["prepared_before_plan"]
                        )
                        observation["prepared_after_plan"] = await prepared_entries(
                            reader, statement[0]
                        )
                        observation["retained_inactive_gates"] = (
                            assert_inactive_sources_unread(observation["plan"])
                        )
                        assert all(
                            item["backend_pid"] == identity["backend_pid"]
                            for item in observation["warmups"]
                        )
                        prepared_name = observation["prepared_before_plan"][0]["name"]
                        assert all(
                            item["prepared"][0]["name"] == prepared_name
                            for item in observation["warmups"]
                        )
                        marker = await writer.scalar(
                            select(Board.name).where(Board.id == board_id)
                        )
                        assert marker is not None
                        await reader.execute(
                            update(Board)
                            .where(Board.id == board_id)
                            .values(name="scope SSI marker")
                        )
                        await writer.execute(
                            update(Source)
                            .where(Source.id == foreign_source)
                            .values(reason="synthetic SSI update")
                        )
                        await reader_tx.commit()
                        observation["reader_committed"] = True
                        await writer_tx.commit()
                        observation["writer_committed"] = True
                        foreign_page, foreign_tuple = map(
                            int, locations[str(foreign_source)].strip("()").split(",")
                        )
                        for lock in observation["reader_predicate_locks"]:
                            if lock["relation"] == "session_search_sources":
                                assert lock["locktype"] != "relation"
                                assert not (
                                    lock["page"] == foreign_page
                                    and lock["tuple"] in (None, foreign_tuple)
                                )
                    finally:
                        if reader_tx.is_active:
                            await reader_tx.rollback()
                        if writer_tx.is_active:
                            await writer_tx.rollback()
        async with pg["factory"]() as fresh:
            assert normalized(await aggregate(fresh)) == expected
            assert (
                await fresh.scalar(
                    select(Source.reason).where(Source.id == foreign_source)
                )
                == "synthetic SSI update"
            )
    finally:
        try:
            output.write_text(json.dumps(observation, indent=2) + "\n")
        finally:
            await other_fixture.aclose()


async def test_scope_aggregate_selects_actual_mode_on_reused_prepared_connection(
    isolated_scope_pg, tmp_path
):
    pg = isolated_scope_pg
    total = 8193
    await clone_retained_sources(pg, contents=total - 1, indexed=total - 1)
    await analyze_scope_relations(pg)
    expected = normalized(
        empty_aggregate(contents=[content_row("indexed", total, body=COST_BODY)])
    )
    modes = (
        "READ COMMITTED",
        "SERIALIZABLE",
        "REPEATABLE READ",
        "SERIALIZABLE",
        "READ UNCOMMITTED",
        "SERIALIZABLE",
    ) * 2
    output = receipt_path(tmp_path, "scope-prepared-transaction-modes.json")
    assert not output.exists(), "Use a fresh measurement directory"
    observations = []
    engine = pg["factory"].kw["bind"]
    try:
        async with engine.connect() as connection:
            async with AsyncSession(bind=connection, expire_on_commit=False) as db:
                for mode in modes:
                    transaction = await bounded_transaction(db, mode)
                    try:
                        identity = dict(
                            (
                                await db.execute(
                                    text(
                                        "SELECT pg_backend_pid() AS backend_pid, "
                                        "current_setting('transaction_isolation') AS actual_isolation"
                                    )
                                )
                            )
                            .mappings()
                            .one()
                        )
                        with observed_aggregate(db) as observed:
                            result = normalized(await aggregate(db))
                        assert_six_categories(observed)
                        assert result == expected
                        statement = observed["sql"][0]
                        locks = await predicate_locks(db)
                        before = await prepared_entries(db, statement[0])
                        plan = await cached_transaction_plan(db, statement, before)
                        after = await prepared_entries(db, statement[0])
                        observations.append(
                            {
                                **identity,
                                "requested_isolation": mode,
                                "python_default_isolation": connection.default_isolation_level,
                                "prepared_before_plan": before,
                                "prepared_after_plan": after,
                                "actual_call_predicate_locks": locks,
                                "aggregate": result,
                                "raw_aggregate": observed["raw_results"][0],
                                "sql": statement[0],
                                "parameters": list(statement[1]),
                                "plan": plan,
                                "repeated_source_probes": source_work(plan),
                                "retained_inactive_gates": assert_inactive_sources_unread(
                                    plan
                                ),
                            }
                        )
                    finally:
                        await transaction.rollback()
    finally:
        output.write_text(json.dumps(observations, indent=2) + "\n")
    assert len(observations) == len(modes)
    assert len({item["backend_pid"] for item in observations}) == 1
    assert len({item["sql"] for item in observations}) == 1
    assert all(
        item["actual_isolation"] == item["requested_isolation"].lower()
        for item in observations
    )
    assert all(
        len(item["prepared_before_plan"]) == len(item["prepared_after_plan"]) == 1
        for item in observations
    )
    assert len({item["prepared_before_plan"][0]["name"] for item in observations}) == 1
    previous_executions = 0
    for item in observations:
        before = item["prepared_before_plan"][0]
        after = item["prepared_after_plan"][0]
        before_count = before["generic_plans"] + before["custom_plans"]
        after_count = after["generic_plans"] + after["custom_plans"]
        assert before["name"] == after["name"]
        assert before_count > previous_executions
        assert after_count > before_count
        previous_executions = after_count
        if item["actual_isolation"] == "serializable":
            # Retaining the original correlated work here is intentional: a
            # broad source scan would widen SERIALIZABLE predicate locks.
            assert item["repeated_source_probes"] >= total - 1, item["actual_isolation"]
        else:
            assert item["repeated_source_probes"] <= 32, item["actual_isolation"]


async def test_scope_aggregate_keeps_sqlite_without_postgres_functions(db_session):
    with observed_aggregate(db_session) as observation:
        actual = normalized(await aggregate(db_session))
    assert actual == empty_aggregate()
    assert_six_categories(observation, has_content=False)
    assert "current_setting" not in observation["sql"][0][0]
