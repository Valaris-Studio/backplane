# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Preserve successful SERIALIZABLE schedules across metadata implementations.

Run serially with SESSION_CAPTURE_TEST_DATABASE_URL naming a disposable server and
RICH_CAPTURE_REQUIRE_LEGS=1; each database-backed test migrates its own receipted scratch
database there, so no plan inherits another test's relation history. The original
query must commit first; an abort there is an inconclusive fixture, not a skip.
No plan settings, retries, sleeps or oracle reads enter either measured schedule.
"""

import asyncio
import json
import uuid
from dataclasses import astuple

import pytest
from sqlalchemy import and_, case, event, func, select, text, update

from app.models.agent_session import AgentSessionContent as Content
from app.models.kanban.board import Board
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.schemas.companion import MAX_INGEST_EVENT_BYTES
from app.schemas.session_content import TEXT_MEDIA_TYPES
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.test_agent_sessions import record as event_record
from tests.test_session_calls import prompt
from tests.test_session_content_postgres import (
    _alembic,
    _scratch_database,
    database_url,
    post_batch,
)
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_latency_postgres import (
    original_eligible_totals,
    seed_pending_contents,
)
from tests.test_session_search_postgres import pg_inline, receipt_path

paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
EVENT_LEAVES = 2048
UNRELATED_CONTENTS = 4096
COVERAGE_CONTENTS = 2049
COVERAGE_FOREIGN_CONTENTS = 262144
STEP_SECONDS = 10
BODY = b"content needle"
SSI_SCRATCH_PREFIX = "uxc_ssi_"


@pytest.fixture
async def pg(monkeypatch, tmp_path):
    # The planner's access path, and so each SSI predicate footprint, follows
    # relation size and statistics; a shared database carries both between tests.
    async with _scratch_database(
        database_url(), tmp_path, prefix=SSI_SCRATCH_PREFIX
    ) as url:
        _alembic(url, "upgrade", "head")
        with monkeypatch.context() as environment:
            environment.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", url)
            fixture = content_postgres_fixture.__wrapped__()
            try:
                yield await fixture.__anext__()
            finally:
                await fixture.aclose()


def sources_access_path(observation):
    paths = []

    def bitmap_indexes(node):
        # A bitmap heap scan names its indexes on child (possibly And/Or) nodes;
        # its other children, such as subplans, scan unrelated relations.
        for child in node.get("Plans", ()):
            if child["Node Type"].startswith("Bitmap"):
                if "Index Name" in child:
                    yield child["Index Name"]
                yield from bitmap_indexes(child)

    def visit(node):
        if node.get("Relation Name") == "session_search_sources":
            indexes = (
                [node["Index Name"]]
                if "Index Name" in node
                else list(bitmap_indexes(node))
            )
            paths.append(
                node["Node Type"] + (" using " + ", ".join(indexes) if indexes else "")
            )
        for child in node.get("Plans", ()):
            visit(child)

    for plan in observation.get("replanned_no_analyze") or ():
        visit(plan["Plan"])
    return paths


async def serializable_fixture(pg):
    _, unrelated_session, acknowledgements = await pg_inline(
        pg, [b"unrelated retained body"], native="ssi-unrelated"
    )
    await seed_pending_contents(
        pg,
        unrelated_session,
        uuid.UUID(acknowledgements[0]["content_id"]),
        UNRELATED_CONTENTS,
    )
    _, session_id, _ = await pg_inline(pg, [BODY], native="ssi-target")
    # Real independent event leaves cross the expanded-query boundary without
    # fabricating chunks or changing their digest, extractor or byte semantics.
    capture = event_record(
        [prompt(1, json.dumps(["needle"] * EVENT_LEAVES))],
        str(pg["mapping_id"]),
        session="ssi-target",
    )
    assert len(json.dumps(capture["events"][0]).encode()) <= MAX_INGEST_EVENT_BYTES
    result = await post_batch(pg, [capture])
    assert result["rejected"] == [], result
    async with pg["factory"].begin() as db:
        unrelated = (
            (
                await db.execute(
                    select(
                        Content.id,
                        Content.state,
                        Content.coverage,
                        Source.id.label("source_id"),
                        Source.reason,
                    )
                    .join(Source, Source.content_id == Content.id)
                    .where(
                        Content.session_id == unrelated_session,
                        Source.status == "pending",
                    )
                    .order_by(Content.source_order.desc())
                    .limit(1)
                )
            )
            .mappings()
            .one()
        )
        marker_id = await db.scalar(
            select(Board.id).where(Board.workspace_id == pg["workspace_id"])
        )
        counts = (
            await db.execute(
                select(func.count(), func.count(func.distinct(Chunk.source_id))).where(
                    Chunk.session_id == session_id
                )
            )
        ).one()
        assert tuple(counts) == (EVENT_LEAVES + 1, 2)
        for table in (
            "agent_session_contents",
            "session_search_sources",
            "session_search_chunks",
        ):
            await db.execute(text(f"ANALYZE {table}"))
        return {
            "session_id": session_id,
            "marker_id": marker_id,
            "unrelated": dict(unrelated),
            "expected": (2, EVENT_LEAVES * len("needle") + len(BODY)),
            "chunk_count": counts[0],
        }


def deployed_content_coverage_query(session_id, extractor_version):
    # Exact 20eaade coverage algebra: pending is a matching status, not NULL.
    # This fixture has only indexed/missing Sources so that distinction cannot
    # masquerade as a transaction-outcome regression.
    current = and_(
        Source.content_id == Content.id,
        Source.extractor_version == extractor_version,
        Source.source_digest == Content.sha256,
    )
    original = func.coalesce(Content.original_byte_count, Content.byte_count)
    classified = (
        select(
            Content.state.label("state"),
            Content.coverage.label("coverage"),
            case((Content.media_type.in_(TEXT_MEDIA_TYPES), 1), else_=0).label(
                "is_text"
            ),
            Source.status.label("index_status"),
            case((Content.id.in_(set()), 1), else_=0).label("unverified"),
            Content.byte_count.label("stored_bytes"),
            original.label("original_bytes"),
        )
        .select_from(Content)
        .outerjoin(Source, current)
        .where(Content.session_id == session_id)
        .subquery()
    )
    return select(
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.index_status,
        classified.c.unverified,
        func.count(),
        func.coalesce(func.sum(classified.c.stored_bytes), 0),
        func.count(classified.c.stored_bytes),
        func.coalesce(func.sum(classified.c.original_bytes), 0),
        func.count(classified.c.original_bytes),
    ).group_by(
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.index_status,
        classified.c.unverified,
    )


async def coverage_serializable_fixture(pg):
    _, foreign_session, foreign_ack = await pg_inline(
        pg, [b""], native="ssi-coverage-foreign"
    )
    _, session_id, target_ack = await pg_inline(
        pg, [BODY], native="ssi-coverage-target"
    )
    namespace = uuid.uuid4().hex
    foreign_prefix = "00000000" + namespace[:8]
    target_prefix = "ffffffff" + namespace[:8]
    columns = [column.name for column in Content.__table__.columns]
    names = ",".join(f'"{name}"' for name in columns)
    replacements = {
        "id": "(:identity_prefix || lpad(to_hex(g),16,'0'))::uuid",
        "content_key": "md5(:key_prefix || g::text) || md5(g::text || :key_prefix)",
        "source_order": "100 + g",
    }
    projection = ",".join(replacements.get(name, f'c."{name}"') for name in columns)
    # The fixed non-NULL foreign prefix precedes the target Content stream.
    # Event-only NULL suffixes could be skipped by an ordered merge instead.
    async with asyncio.timeout(120):
        async with pg["factory"].begin() as db:
            await db.execute(text("SET LOCAL statement_timeout='90s'"))
            for acknowledgements, count, prefix in (
                (foreign_ack, COVERAGE_FOREIGN_CONTENTS, foreign_prefix),
                (target_ack, COVERAGE_CONTENTS - 1, target_prefix),
            ):
                await db.execute(
                    text(
                        f"INSERT INTO agent_session_contents ({names}) "
                        f"SELECT {projection} FROM agent_session_contents c "
                        "CROSS JOIN generate_series(1, :count) g WHERE c.id=:template"
                    ),
                    {
                        "identity_prefix": prefix,
                        "key_prefix": namespace + prefix,
                        "count": count,
                        "template": uuid.UUID(acknowledgements[0]["content_id"]),
                    },
                )
        async with pg["factory"].begin() as db:
            await db.execute(text("SET LOCAL statement_timeout='90s'"))
            # Refresh after committed growth so FK checks do not inherit a
            # sequential lookup plan for the former two-row Content table.
            await db.execute(text("ANALYZE agent_session_contents"))
            await db.execute(
                text(
                    "INSERT INTO session_search_sources "
                    "(id,session_id,content_id,status,extractor_version,source_digest,"
                    "byte_count,folded_bytes,chunk_count) "
                    "SELECT md5('source:' || c.id::text)::uuid,c.session_id,c.id,"
                    "'indexed',:version,c.sha256,c.byte_count,0,0 "
                    "FROM agent_session_contents c WHERE c.session_id=:session "
                    "AND c.source_order>100"
                ),
                {"version": EXTRACTOR_VERSION, "session": foreign_session},
            )
            unrelated_id = uuid.UUID(
                foreign_prefix + f"{COVERAGE_FOREIGN_CONTENTS // 2:016x}"
            )
            unrelated = (
                (
                    await db.execute(
                        select(
                            Content.id,
                            Content.state,
                            Content.coverage,
                            Source.id.label("source_id"),
                            Source.reason,
                        )
                        .join(Source, Source.content_id == Content.id)
                        .where(Content.id == unrelated_id)
                    )
                )
                .mappings()
                .one()
            )
            target_ids = list(
                await db.scalars(
                    select(Content.id).where(Content.session_id == session_id)
                )
            )
            assert len(target_ids) == COVERAGE_CONTENTS
            last_foreign_id = uuid.UUID(
                foreign_prefix + f"{COVERAGE_FOREIGN_CONTENTS:016x}"
            )
            assert last_foreign_id < min(
                target_ids
            ), "Fixed identity ranges did not separate; do not adapt this fixture"
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(Source)
                    .join(Content, Content.id == Source.content_id)
                    .where(Content.session_id == session_id)
                )
                == 1
            )
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(Source)
                    .join(Content, Content.id == Source.content_id)
                    .where(
                        Content.session_id == foreign_session,
                        Source.status == "indexed",
                        Source.extractor_version == EXTRACTOR_VERSION,
                        Source.source_digest == Content.sha256,
                        Content.byte_count == 0,
                        Content.inline_text == "",
                        Source.chunk_count == 0,
                    )
                )
                == COVERAGE_FOREIGN_CONTENTS + 1
            )
            marker_id = await db.scalar(
                select(Board.id).where(Board.workspace_id == pg["workspace_id"])
            )
            for table in (
                "agent_session_contents",
                "session_search_sources",
                "session_search_chunks",
            ):
                await db.execute(text(f"ANALYZE {table}"))
    expected = tuple(
        sorted(
            (
                (
                    "available",
                    "captured",
                    True,
                    status,
                    False,
                    count,
                    count * len(BODY),
                    count,
                    count * len(BODY),
                    count,
                )
                for status, count in (("indexed", 1), (None, COVERAGE_CONTENTS - 1))
            ),
            key=repr,
        )
    )
    return {
        "session_id": session_id,
        "marker_id": marker_id,
        "unrelated": dict(unrelated),
        "expected": expected,
        "content_count": COVERAGE_CONTENTS,
        "target_source_count": 1,
        "foreign_copied_content_sources": COVERAGE_FOREIGN_CONTENTS,
        "foreign_identity_prefix": foreign_prefix,
        "target_identity_prefix": target_prefix,
        "foreign_template_id": foreign_ack[0]["content_id"],
        "target_template_id": target_ack[0]["content_id"],
        "write_unrelated_content": False,
    }


def error_receipt(error):
    original = getattr(error, "orig", error)
    return {
        "type": type(error).__name__,
        "sqlstate": getattr(original, "sqlstate", getattr(original, "pgcode", None)),
        "message": str(error),
    }


async def metadata_schedule(
    pg, fixture, implementation, receipt, save, *, metadata="eligibility"
):
    factory = pg["factory"]
    unrelated = fixture["unrelated"]
    async with factory.begin() as db:
        await db.execute(
            update(Board)
            .where(Board.id == fixture["marker_id"])
            .values(name="ssi before")
        )
        if fixture.get("write_unrelated_content", True):
            await db.execute(
                update(Content)
                .where(Content.id == unrelated["id"])
                .values(
                    state=unrelated["state"],
                    coverage=unrelated["coverage"],
                )
            )
        await db.execute(
            update(Source)
            .where(Source.id == unrelated["source_id"])
            .values(reason=unrelated["reason"])
        )
        unrelated_source_location = dict(
            (
                await db.execute(
                    text(
                        "SELECT tableoid::regclass::text relation, ctid::text tuple_location "
                        "FROM session_search_sources WHERE id=:source"
                    ),
                    {"source": unrelated["source_id"]},
                )
            )
            .mappings()
            .one()
        )

    observation = {
        "implementation": implementation,
        "unrelated_source_location_before": unrelated_source_location,
        "statements": [],
        "locks": [],
        "outcomes": {"T1": {"status": "not_started"}, "T2": {"status": "not_started"}},
    }
    receipt["schedules"].append(observation)
    save()
    engine = factory.kw["bind"]
    role, stage = "T1", "begin"

    def capture(_connection, _cursor, sql, parameters, _context, _many):
        observation["statements"].append(
            {
                "role": role,
                "stage": stage,
                "sql": sql,
                "parameters": parameters,
            }
        )

    async with factory() as first, factory() as second, factory() as observer:
        transactions = {"T1": await first.begin(), "T2": await second.begin()}
        pids = {}
        event.listen(engine.sync_engine, "before_cursor_execute", capture)
        try:
            async with asyncio.timeout(45):
                for role, db in (("T1", first), ("T2", second)):
                    stage = "begin"
                    await db.execute(
                        text("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                    )
                    await db.execute(text("SET LOCAL statement_timeout='8s'"))
                    await db.execute(text("SET LOCAL lock_timeout='3s'"))
                    row = (
                        (
                            await db.execute(
                                text(
                                    "SELECT pg_backend_pid() pid, current_setting('transaction_isolation') isolation"
                                )
                            )
                        )
                        .mappings()
                        .one()
                    )
                    assert row["isolation"] == "serializable", row
                    pids[role] = row["pid"]
                    observation["outcomes"][role] = {"status": "active"}
                observation["pids"] = pids
                role, stage = "observer", "begin"
                await observer.execute(
                    text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED")
                )
                await observer.execute(text("SET LOCAL statement_timeout='8s'"))

                async def observe_locks(label):
                    nonlocal role, stage
                    role, stage = "observer", label
                    rows = (
                        await observer.execute(
                            text(
                                "SELECT pid, locktype, mode, relation::regclass::text relation, "
                                "page, tuple, virtualtransaction, transactionid::text, granted "
                                "FROM pg_locks WHERE pid IN (:first, :second) "
                                "ORDER BY pid, locktype, relation, page, tuple, mode"
                            ),
                            {"first": pids["T1"], "second": pids["T2"]},
                        )
                    ).mappings()
                    observation["locks"].append(
                        {"stage": label, "rows": [dict(row) for row in rows]}
                    )
                    save()

                role, stage = "T1", metadata
                repo = SessionSearchRepository(first)
                if metadata == "eligibility":
                    scope = SearchScope(EXTRACTOR_VERSION)
                    observation["result"] = (
                        await original_eligible_totals(
                            repo, fixture["session_id"], scope
                        )
                        if implementation == "original"
                        else await repo.eligible_totals(fixture["session_id"], scope)
                    )
                else:
                    assert metadata == "coverage"
                    if implementation == "original":
                        raw_rows = list(
                            await first.execute(
                                deployed_content_coverage_query(
                                    fixture["session_id"], EXTRACTOR_VERSION
                                )
                            )
                        )
                        rows = [
                            (
                                row[0],
                                row[1],
                                bool(row[2]),
                                row[3],
                                bool(row[4]),
                                *(int(value) for value in row[5:]),
                            )
                            for row in raw_rows
                        ]
                        observation["raw_result"] = [tuple(row) for row in raw_rows]
                    else:
                        rows = [
                            astuple(row)
                            for row in await repo.content_coverage(
                                fixture["session_id"], EXTRACTOR_VERSION, set()
                            )
                        ]
                        observation["raw_result"] = rows
                    observation["result"] = tuple(sorted(rows, key=repr))
                save()
                await observe_locks("after_metadata")
                [metadata_statement] = [
                    item
                    for item in observation["statements"]
                    if item["role"] == "T1" and item["stage"] == metadata
                ]
                role, stage = "observer", "metadata_plan_replay"
                connection = await observer.connection()
                raw_plan = (
                    await connection.exec_driver_sql(
                        "EXPLAIN (FORMAT JSON) " + metadata_statement["sql"],
                        metadata_statement["parameters"],
                    )
                ).scalar_one()
                observation["replanned_no_analyze"] = (
                    json.loads(raw_plan) if isinstance(raw_plan, str) else raw_plan
                )
                role, stage = "T2", "read_marker"
                observation["marker_read"] = await second.scalar(
                    select(Board.name).where(Board.id == fixture["marker_id"])
                )
                role, stage = "T1", "write_marker"
                await first.execute(
                    update(Board)
                    .where(Board.id == fixture["marker_id"])
                    .values(name="ssi after")
                )
                await observe_locks("after_marker_write")

                role, stage = "T2", "write_unrelated"
                try:
                    await second.execute(
                        update(Source)
                        .where(Source.id == unrelated["source_id"])
                        .values(reason="ssi unrelated")
                    )
                    if fixture.get("write_unrelated_content", True):
                        await second.execute(
                            update(Content)
                            .where(Content.id == unrelated["id"])
                            .values(
                                state="recorded",
                                coverage="withheld_by_policy",
                            )
                        )
                except Exception as error:
                    observation["outcomes"]["T2"] = {
                        "status": "failed",
                        "stage": stage,
                        **error_receipt(error),
                    }
                    await asyncio.wait_for(transactions["T2"].rollback(), STEP_SECONDS)
                    save()
                await observe_locks("after_unrelated_write")

                # Awaited statements are the barriers: neither transaction is
                # committed until both writes have been attempted. T1 commits first.
                for role in ("T1", "T2"):
                    if observation["outcomes"][role]["status"] != "active":
                        continue
                    stage = "commit"
                    try:
                        await asyncio.wait_for(
                            transactions[role].commit(), STEP_SECONDS
                        )
                        observation["outcomes"][role] = {
                            "status": "committed",
                            "sqlstate": None,
                        }
                    except Exception as error:
                        observation["outcomes"][role] = {
                            "status": "failed",
                            "stage": stage,
                            **error_receipt(error),
                        }
                    save()
                await observe_locks("after_commits")
        except Exception as error:
            observation["schedule_error"] = {
                "role": role,
                "stage": stage,
                **error_receipt(error),
            }
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", capture)
            for label, db in (("T1", first), ("T2", second), ("observer", observer)):
                try:
                    await asyncio.wait_for(db.rollback(), STEP_SECONDS)
                    if (
                        label in observation["outcomes"]
                        and observation["outcomes"][label]["status"] == "active"
                    ):
                        observation["outcomes"][label] = {"status": "rolled_back"}
                except Exception as error:
                    observation.setdefault("cleanup_errors", []).append(
                        {"role": label, **error_receipt(error)}
                    )
            save()

    observation["sources_access_path"] = sources_access_path(observation)
    async with factory() as db:
        observation["committed_rows"] = {
            "marker": await db.scalar(
                select(Board.name).where(Board.id == fixture["marker_id"])
            ),
            "content": dict(
                (
                    await db.execute(
                        select(Content.state, Content.coverage).where(
                            Content.id == unrelated["id"]
                        )
                    )
                )
                .mappings()
                .one()
            ),
            "source_reason": await db.scalar(
                select(Source.reason).where(Source.id == unrelated["source_id"])
            ),
        }
    save()
    return observation


async def record_database_environment(pg, receipt):
    async with pg["factory"]() as db:
        receipt["database"] = dict(
            (
                await db.execute(
                    text(
                        "SELECT version() version, current_database() database, "
                        "current_setting('max_pred_locks_per_transaction') max_pred_locks_per_transaction, "
                        "current_setting('max_pred_locks_per_relation') max_pred_locks_per_relation, "
                        "current_setting('max_pred_locks_per_page') max_pred_locks_per_page"
                    )
                )
            )
            .mappings()
            .one()
        )
        receipt["migration_heads"] = list(
            await db.scalars(text("SELECT version_num FROM alembic_version"))
        )
        receipt["indexes"] = [
            dict(row)
            for row in (
                await db.execute(
                    text(
                        "SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes "
                        "WHERE schemaname=current_schema() AND tablename IN "
                        "('session_search_chunks','session_search_sources','agent_session_contents','boards') "
                        "ORDER BY tablename,indexname"
                    )
                )
            ).mappings()
        ]


def assert_preserved_schedule(observation, fixture, receipt, save, metadata):
    committed = all(
        result["status"] == "committed" for result in observation["outcomes"].values()
    )
    if "schedule_error" in observation or "cleanup_errors" in observation:
        receipt["classification"] = "INCONCLUSIVE_SCHEDULE_OR_CLEANUP_ERROR"
        save()
        pytest.fail(f"No transaction comparison: {observation}")
    if not committed and any(
        result["status"] not in {"committed", "failed"}
        or (result["status"] == "failed" and result.get("sqlstate") != "40001")
        for result in observation["outcomes"].values()
    ):
        receipt["classification"] = "INCONCLUSIVE_NON_SERIALIZATION_OUTCOME"
        save()
        pytest.fail(f"No serialization comparison: {observation}")
    if observation["implementation"] == "original" and not committed:
        receipt["classification"] = "INCONCLUSIVE_BASELINE_DID_NOT_COMMIT"
        save()
        pytest.fail(
            "Original schedule did not commit; Sources access path "
            f"{sources_access_path(observation)}; no candidate conclusion: {observation}"
        )
    assert tuple(observation["result"]) == fixture["expected"], observation
    assert observation["marker_read"] == "ssi before", observation
    assert any(
        item["stage"] == metadata for item in observation["statements"]
    ), observation
    assert any(
        row["pid"] == observation["pids"]["T1"] and row["mode"] == "SIReadLock"
        for snapshot in observation["locks"]
        if snapshot["stage"] == "after_metadata"
        for row in snapshot["rows"]
    ), f"Inconclusive: no metadata predicate locks were captured: {observation}"
    if observation["implementation"] == "candidate" and not committed:
        receipt["classification"] = "CANDIDATE_DID_NOT_PRESERVE_BASELINE_COMMITS"
        save()
    assert committed, f"{metadata.title()} changed a successful baseline SERIALIZABLE schedule: {observation}"
    expected_content = (
        {"state": "recorded", "coverage": "withheld_by_policy"}
        if fixture.get("write_unrelated_content", True)
        else {
            "state": fixture["unrelated"]["state"],
            "coverage": fixture["unrelated"]["coverage"],
        }
    )
    assert observation["committed_rows"] == {
        "marker": "ssi after",
        "content": expected_content,
        "source_reason": "ssi unrelated",
    }, observation


PKEY_SOURCES_REPLAN = [
    {
        "Plan": {
            "Node Type": "Nested Loop",
            "Plans": [
                {"Node Type": "Seq Scan", "Relation Name": "session_search_chunks"},
                {
                    "Node Type": "Memoize",
                    "Plans": [
                        {
                            "Node Type": "Index Scan",
                            "Relation Name": "session_search_sources",
                            "Index Name": "session_search_sources_pkey",
                        }
                    ],
                },
            ],
        }
    }
]


def test_sources_access_path_names_each_sources_scan():
    bitmap = [
        {
            "Plan": {
                "Node Type": "Bitmap Heap Scan",
                "Relation Name": "session_search_sources",
                "Plans": [
                    {
                        "Node Type": "Bitmap Index Scan",
                        "Index Name": "ix_session_search_sources_indexed_metadata",
                    }
                ],
            }
        }
    ]
    bitmap_or_with_subplan = [
        {
            "Plan": {
                "Node Type": "Bitmap Heap Scan",
                "Relation Name": "session_search_sources",
                "Plans": [
                    {
                        "Node Type": "BitmapOr",
                        "Plans": [
                            {
                                "Node Type": "Bitmap Index Scan",
                                "Index Name": "ix_session_search_sources_indexed_metadata",
                            },
                            {
                                "Node Type": "Bitmap Index Scan",
                                "Index Name": "ix_session_search_sources_event_metadata",
                            },
                        ],
                    },
                    {
                        "Node Type": "Index Only Scan",
                        "Parent Relationship": "SubPlan",
                        "Relation Name": "boards",
                        "Index Name": "boards_pkey",
                    },
                ],
            }
        }
    ]
    sequential = [
        {"Plan": {"Node Type": "Seq Scan", "Relation Name": "session_search_sources"}}
    ]
    assert sources_access_path({"replanned_no_analyze": PKEY_SOURCES_REPLAN}) == [
        "Index Scan using session_search_sources_pkey"
    ]
    assert sources_access_path({"replanned_no_analyze": bitmap}) == [
        "Bitmap Heap Scan using ix_session_search_sources_indexed_metadata"
    ]
    assert sources_access_path({"replanned_no_analyze": bitmap_or_with_subplan}) == [
        "Bitmap Heap Scan using ix_session_search_sources_indexed_metadata, "
        "ix_session_search_sources_event_metadata"
    ]
    assert sources_access_path({"replanned_no_analyze": sequential}) == ["Seq Scan"]
    assert sources_access_path({}) == []


def test_baseline_failure_names_the_sources_access_path():
    observation = {
        "implementation": "original",
        "outcomes": {
            "T1": {"status": "committed", "sqlstate": None},
            "T2": {"status": "failed", "stage": "commit", "sqlstate": "40001"},
        },
        "replanned_no_analyze": PKEY_SOURCES_REPLAN,
    }
    receipt = {}
    with pytest.raises(
        pytest.fail.Exception,
        match=r"Sources access path \['Index Scan using session_search_sources_pkey'\]",
    ):
        assert_preserved_schedule(observation, {}, receipt, lambda: None, "eligibility")
    assert receipt["classification"] == "INCONCLUSIVE_BASELINE_DID_NOT_COMMIT"


async def assert_owned_fresh_relation_history(pg):
    async with pg["factory"]() as db:
        database = await db.scalar(text("SELECT current_database()"))
        # Heap size alone is not history: autovacuum truncates emptied heaps
        # while cumulative row activity and index bloat remain.
        history = {
            row.relname: (row.heap_bytes, row.inserted, row.updated, row.deleted)
            for row in await db.execute(
                text(
                    "SELECT c.relname, pg_relation_size(c.oid) AS heap_bytes, "
                    "s.n_tup_ins AS inserted, s.n_tup_upd AS updated, "
                    "s.n_tup_del AS deleted "
                    "FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid "
                    "WHERE c.relnamespace = current_schema()::regnamespace "
                    "AND c.relname IN ('agent_session_contents', "
                    "'session_search_sources', 'session_search_chunks')"
                )
            )
        }
    assert database.startswith(SSI_SCRATCH_PREFIX), database
    assert history == {
        "agent_session_contents": (0, 0, 0, 0),
        "session_search_sources": (0, 0, 0, 0),
        "session_search_chunks": (0, 0, 0, 0),
    }, history


@pytest.mark.timeout(120)
async def test_serializable_fixture_owns_relations_without_inherited_history(pg):
    await assert_owned_fresh_relation_history(pg)


@pytest.mark.timeout(150)
async def test_eligibility_preserves_baseline_serializable_commits(pg, tmp_path):
    output = receipt_path(tmp_path, "metadata-serializable-outcomes.json")
    assert (
        not output.exists()
    ), "Use a fresh measurement directory; preserve earlier outcomes"
    receipt = {
        "schedule": "T1 metadata; T2 marker read; T1 marker write; T2 unrelated writes; T1 commit; T2 commit",
        "scope": "standalone eligibility; default public SearchScope; independent SERIALIZABLE transactions",
        "baseline": "original_eligible_totals using repository._scanned on this same current schema/index set; not a historical deployed-plan attestation",
        "plans": "External observer EXPLAIN without ANALYZE replans captured SQL; participant pg_locks are the observed predicate footprint",
        "schedules": [],
    }

    def save():
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

    save()
    fixture = await serializable_fixture(pg)
    receipt["fixture"] = fixture
    await record_database_environment(pg, receipt)
    save()
    for implementation in ("original", "candidate"):
        observation = await metadata_schedule(
            pg, fixture, implementation, receipt, save
        )
        assert_preserved_schedule(observation, fixture, receipt, save, "eligibility")
    receipt["classification"] = "BASELINE_AND_CANDIDATE_COMMITTED"
    save()


@pytest.mark.timeout(300)
async def test_coverage_preserves_deployed_serializable_commits(pg, tmp_path):
    output = receipt_path(tmp_path, "metadata-coverage-serializable-outcomes.json")
    assert (
        not output.exists()
    ), "Use a fresh measurement directory; preserve earlier outcomes"
    receipt = {
        "schedule": "T1 coverage; T2 marker read; T1 marker write; T2 unrelated Source.reason write; T1 commit; T2 commit",
        "scope": "standalone content coverage with empty unverified set; independent SERIALIZABLE transactions",
        "baseline": "20eaadecf705fcedcc9d4bcbd2a265885d480dc0 SessionSearchRepository.content_coverage SELECT, without terminal-status filtering, on this same current schema/index set; not a historical deployed-plan attestation",
        "baseline_semantics": "All present Sources are current indexed Sources; missing Sources form NULL groups. No pending Source conceals the deployed/current raw-status difference.",
        "plans": "External observer EXPLAIN without ANALYZE replans captured SQL; participant pg_locks and the unrelated Source heap location are observed, not inferred from the replan",
        "fixed_fixture": {
            "target_contents": COVERAGE_CONTENTS,
            "target_sources": 1,
            "foreign_copied_content_sources": COVERAGE_FOREIGN_CONTENTS,
            "foreign_order": "All copied non-NULL Content IDs precede every target Content ID",
            "unrelated_writer": "Source for the fixed middle foreign Content ID; reason only",
            "plan_control": "ordinary ANALYZE only; no retries or post-result fixture adaptation",
        },
        "schedules": [],
    }

    def save():
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

    save()
    try:
        fixture = await coverage_serializable_fixture(pg)
    except Exception as error:
        receipt["classification"] = "INCONCLUSIVE_FIXTURE_ERROR"
        receipt["fixture_error"] = error_receipt(error)
        save()
        raise
    receipt["fixture"] = fixture
    await record_database_environment(pg, receipt)
    save()
    for implementation in ("original", "candidate"):
        observation = await metadata_schedule(
            pg, fixture, implementation, receipt, save, metadata="coverage"
        )
        assert_preserved_schedule(observation, fixture, receipt, save, "coverage")
    receipt["classification"] = "BASELINE_AND_CANDIDATE_COMMITTED"
    save()
