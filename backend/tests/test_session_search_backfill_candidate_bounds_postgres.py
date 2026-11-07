# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Candidate parity and bounded source work on disposable PostgreSQL.

Each case migrates its own receipted scratch database (CB_SCRATCH_PREFIX) and
pins autovacuum off on the five synthetic tables, so neither another test's
relation history nor vacuum timing enters the planner's cost model. The
merge-path control models a valid plan that must not walk the settled source
prefix: it names the Sources access path and measures rows visited, not a
machine-dependent latency. The default plan may read the small synthetic corpus
sequentially, but any index it takes on Sources must be the bounded cursor index.
"""

import hashlib
import json
import uuid
from dataclasses import asdict
from pathlib import Path

import pytest
from sqlalchemy import delete, func, insert, select, text

from app.models.agent_session import AgentSessionContent, AgentSessionEvent
from app.models.session_search import SessionSearchSource
from app.models.workspace import WorkspaceMember, WorkspaceRole
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.rich_capture import declaration
from tests.test_session_content_postgres import (
    _alembic,
    _scratch_database,
    database_url,
    pg as capture_postgres_fixture,
    post_batch,
    session_record,
)
from tests.test_session_search import paused_object_indexing as paused_indexing_fixture
from tests.test_session_search_backfill_plans_postgres import (
    assert_no_body_projection,
    capture_selects,
    plan_nodes,
)

paused_object_indexing = paused_indexing_fixture
CB_SCRATCH_PREFIX = "uxc_cb_"
BOUNDED_SOURCE_INDEX = {
    "content": "uq_session_search_source_content",
    "event": "uq_session_search_source_event",
    "verification": "uq_session_search_source_content",
}


@pytest.fixture
async def pg(monkeypatch, tmp_path):
    # Plan cost follows relation size, visibility and statistics; a shared
    # database carries all three from earlier tests into this one.
    async with _scratch_database(
        database_url(), tmp_path, prefix=CB_SCRATCH_PREFIX
    ) as url:
        _alembic(url, "upgrade", "head")
        with monkeypatch.context() as environment:
            environment.setenv("SESSION_CAPTURE_TEST_DATABASE_URL", url)
            fixture = capture_postgres_fixture.__wrapped__()
            try:
                yield await fixture.__anext__()
            finally:
                await fixture.aclose()


pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
PREFIX_SIZE = 4_096
PAGE_SIZE = 200
TAIL_SIZE = 64
BODY = "Synthetic candidate metadata Stra\u00dfe".encode()
DIGEST = hashlib.sha256(BODY).hexdigest()
TABLES = (
    "agent_sessions", "agent_session_contents", "agent_session_events",
    "session_search_sources", "workspace_members",
)


def source_facts(ordinal):
    if ordinal <= PREFIX_SIZE:
        return "unavailable", EXTRACTOR_VERSION, DIGEST
    return (
        None,
        ("indexed", EXTRACTOR_VERSION, DIGEST),
        ("unavailable", EXTRACTOR_VERSION, DIGEST),
        ("unavailable", "old-extractor", DIGEST),
        ("unavailable", EXTRACTOR_VERSION, "f" * 64),
        ("pending", EXTRACTOR_VERSION, DIGEST),
        ("not_text", EXTRACTOR_VERSION, DIGEST),
        ("unavailable", EXTRACTOR_VERSION, DIGEST),
    )[ordinal % 8]


async def seed_candidates(env, kind):
    factory = env["factory"]
    async with factory.begin() as db:
        for model in (AgentSessionContent, AgentSessionEvent, SessionSearchSource):
            assert await db.scalar(select(func.count()).select_from(model)) == 0
        assert int(await db.scalar(text("SELECT version_num FROM alembic_version"))) >= 126
        for name in TABLES:
            # No vacuum may change visibility or free space between seeding and planning.
            await db.execute(text(f'ALTER TABLE "{name}" SET (autovacuum_enabled = off)'))
    result = await post_batch(env, [session_record(
        env, "candidate-bounds-" + uuid.uuid4().hex, [declaration(BODY)],
    )])
    assert result["rejected"] == []
    [ack] = result["contents"]
    async with factory.begin() as db:
        template = await db.get(AgentSessionContent, uuid.UUID(ack["content_id"]))
        content_values = {
            column.name: getattr(template, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        session_id = template.session_id
        await db.execute(delete(AgentSessionContent).where(
            AgentSessionContent.id == template.id
        ))
        for start in range(1, PREFIX_SIZE + PAGE_SIZE + TAIL_SIZE + 1, 500):
            candidates, sources = [], []
            for ordinal in range(start, min(start + 500, PREFIX_SIZE + PAGE_SIZE + TAIL_SIZE + 1)):
                identity = uuid.UUID(int=ordinal)
                if kind == "event":
                    candidates.append({
                        "id": identity, "session_id": session_id,
                        "event_id": str(identity), "capture_id": template.capture_id,
                        "occurred_at": template.occurred_at,
                        "received_at": template.received_at,
                        "action": "synthetic.candidate", "collection_method": "hook",
                        "event": {},
                    })
                else:
                    candidates.append({
                        **content_values, "id": identity,
                        "content_key": hashlib.sha256(identity.bytes).hexdigest(),
                        "source_order": ordinal,
                    })
                facts = source_facts(ordinal)
                if facts is not None:
                    status, version, digest = facts
                    sources.append({
                        "id": uuid.uuid4(), "session_id": session_id,
                        "content_id": identity if kind != "event" else None,
                        "event_id": identity if kind == "event" else None,
                        "status": status, "extractor_version": version,
                        "source_digest": digest,
                    })
            model = AgentSessionEvent if kind == "event" else AgentSessionContent
            await db.execute(insert(model), candidates)
            await db.execute(insert(SessionSearchSource), sources)
        for name in TABLES:
            await db.execute(text(f'ANALYZE "{name}"'))


async def candidates(factory, kind, after, upper):
    async with factory() as db:
        repository = SessionSearchBackfillRepository(db)
        options = {
            "after": uuid.UUID(int=after) if after is not None else None,
            "upper": uuid.UUID(int=upper), "limit": PAGE_SIZE,
        }
        if kind == "event":
            return await repository.event_candidates(**options)
        return await repository.content_candidates(
            **options,
            recorded_unavailable_in=EXTRACTOR_VERSION if kind == "verification" else None,
        )


def assert_candidates(rows, kind, ordinals, *, member=True):
    assert [row.id.int for row in rows] == list(ordinals)
    for row in rows:
        assert row.member is member
        facts = source_facts(row.id.int)
        if kind == "verification" and facts != ("unavailable", EXTRACTOR_VERSION, DIGEST):
            facts = None
        assert row.index_status == (facts[0] if facts else None)
        assert row.index_version == (facts[1] if facts else None)
        if kind != "event":
            assert row.index_digest == (facts[2] if facts else None)
            assert row.sha256 == DIGEST
            assert row.state == "available"
            assert row.coverage == "captured"
            assert row.media_type == "text/plain"
            assert row.inline and row.inline_bytes == len(BODY)


async def candidate_plan(engine, query, *, merge_control):
    async with engine.connect() as connection:
        await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        await connection.exec_driver_sql("SET LOCAL statement_timeout = '10s'")
        if merge_control:
            # Exercise the production-observed merge path on a small local corpus.
            for setting in ("enable_hashjoin", "enable_nestloop", "enable_seqscan", "enable_bitmapscan"):
                await connection.exec_driver_sql(f"SET LOCAL {setting} = off")
        raw = (await connection.exec_driver_sql(
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + query["sql"],
            query["parameters"],
        )).scalar_one()
        return json.loads(raw) if isinstance(raw, str) else raw


def sources_scans(plan):
    """Every Sources scan in a plan: its access path and the rows it had to look at."""
    scans = []
    for node in plan_nodes(plan):
        if node.get("Relation Name") != "session_search_sources":
            continue
        # A bitmap heap scan names its indexes on child (possibly And/Or) nodes.
        indexes = [node["Index Name"]] if "Index Name" in node else [
            child["Index Name"]
            for child in plan_nodes(node)
            if child is not node and "Index Name" in child
        ]
        loops = node.get("Actual Loops", 1)
        removed = node.get("Rows Removed by Filter", 0)
        scans.append({
            "node": node["Node Type"],
            "index": ", ".join(indexes) if indexes else None,
            "index_condition": any("Index Cond" in inner for inner in plan_nodes(node)),
            "rows": node["Actual Rows"], "loops": loops, "removed_by_filter": removed,
            "heap_fetches": node.get("Heap Fetches"),
            "visited": (node["Actual Rows"] + removed) * loops,
        })
    return scans


async def relation_state(factory):
    async with factory() as db:
        rows = await db.execute(text(
            "SELECT c.relname, c.relpages, c.reltuples, c.relallvisible, c.reloptions, "
            "s.n_live_tup, s.n_dead_tup, s.last_vacuum, s.last_autovacuum "
            "FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid "
            "WHERE c.relname = ANY(:names) ORDER BY c.relname"
        ), {"names": list(TABLES)})
        return [
            {key: (str(value) if key.startswith("last_") else value) for key, value in row._mapping.items()}
            for row in rows
        ]


@pytest.mark.parametrize("kind", ["content", "event", "verification"])
async def test_candidate_source_scan_stays_within_cursor_window(pg, kind, tmp_path):
    factory = pg["factory"]
    engine = factory.kw["bind"]
    evidence = {"kind": kind, "prefix_rows": PREFIX_SIZE, "candidate_limit": PAGE_SIZE}
    try:
        await seed_candidates(pg, kind)
        upper = PREFIX_SIZE + PAGE_SIZE + TAIL_SIZE
        windows = (
            (None, 8, range(1, 9)),
            (PREFIX_SIZE, upper, range(PREFIX_SIZE + 1, PREFIX_SIZE + PAGE_SIZE + 1)),
            (upper - 3, upper, range(upper - 2, upper + 1)),
            (upper, upper, range(0)),
        )
        for after, bound, expected in windows:
            rows = await candidates(factory, kind, after, bound)
            assert_candidates(rows, kind, expected)
        evidence["boundary_parity"] = True

        rows = await candidates(factory, kind, PREFIX_SIZE, upper)
        async with factory.begin() as db:
            await db.execute(delete(WorkspaceMember).where(
                WorkspaceMember.workspace_id == pg["workspace_id"],
                WorkspaceMember.user_id == pg["owner_id"],
            ))
        revoked = await candidates(factory, kind, PREFIX_SIZE, upper)
        assert_candidates(revoked, kind, range(PREFIX_SIZE + 1, PREFIX_SIZE + PAGE_SIZE + 1), member=False)
        assert [asdict(row) | {"member": False} for row in rows] == [asdict(row) for row in revoked]
        async with factory.begin() as db:
            db.add(WorkspaceMember(
                workspace_id=pg["workspace_id"], user_id=pg["owner_id"], role=WorkspaceRole.owner,
            ))
        evidence["membership_change_preserves_candidates"] = True

        with capture_selects(engine) as queries:
            restored = await candidates(factory, kind, PREFIX_SIZE, upper)
        assert restored == rows
        assert len(queries) == 1
        assert_no_body_projection(queries)
        [query] = queries
        evidence["query_sha256"] = hashlib.sha256(query["sql"].encode()).hexdigest()
        evidence["default_plan"] = await candidate_plan(engine, query, merge_control=False)
        controlled = await candidate_plan(engine, query, merge_control=True)
        evidence["local_merge_control_plan"] = controlled
        evidence["scratch_database"] = engine.url.database
        evidence["relations_at_plan"] = await relation_state(factory)
        controlled_scans = sources_scans(controlled[0]["Plan"])
        default_scans = sources_scans(evidence["default_plan"][0]["Plan"])
        evidence["controlled_sources_scans"] = controlled_scans
        evidence["default_sources_scans"] = default_scans
        nodes = list(plan_nodes(controlled[0]["Plan"]))
        assert any(node["Node Type"] == "Merge Join" for node in nodes)
        assert controlled_scans, evidence
        # The control must take the cursor range on the bounded unique index, never
        # as a filter over another index that walks the settled prefix.
        assert [scan["index"] for scan in controlled_scans] == (
            [BOUNDED_SOURCE_INDEX[kind]] * len(controlled_scans)
        ), evidence
        assert all(scan["index_condition"] for scan in controlled_scans), evidence
        source_rows_visited = sum(scan["visited"] for scan in controlled_scans)
        evidence["source_rows_visited"] = source_rows_visited
        assert controlled[0]["Plan"]["Actual Rows"] == PAGE_SIZE
        # A sort may consume the entire bounded interval before LIMIT.
        assert source_rows_visited <= upper - PREFIX_SIZE, evidence
        # The default plan may scan the small synthetic corpus sequentially; an
        # index path on Sources must be the bounded one and stay within the cursor.
        assert evidence["default_plan"][0]["Plan"]["Actual Rows"] == PAGE_SIZE, evidence
        for scan in default_scans:
            if scan["index"] is not None:
                assert scan["index"] == BOUNDED_SOURCE_INDEX[kind], evidence
                assert scan["index_condition"], evidence
                assert scan["visited"] <= upper - PREFIX_SIZE, evidence
    finally:
        evidence["test_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        repository_path = Path(__file__).parents[1] / "app/repositories/session_search_backfill.py"
        evidence["repository_sha256"] = hashlib.sha256(repository_path.read_bytes()).hexdigest()
        (tmp_path / "candidate-bounds-plan.json").write_text(json.dumps(evidence, indent=2) + "\n")


def test_sources_scans_name_index_and_filter_work():
    plan = {
        "Node Type": "Limit",
        "Plans": [{
            "Node Type": "Merge Join",
            "Plans": [
                {
                    "Node Type": "Index Only Scan",
                    "Relation Name": "session_search_sources",
                    "Index Name": "ix_session_search_sources_event_metadata",
                    "Actual Rows": 231, "Actual Loops": 1,
                    "Rows Removed by Filter": 4096, "Heap Fetches": 4327,
                    "Filter": "(event_id > $1)",
                },
                {
                    "Node Type": "Bitmap Heap Scan",
                    "Relation Name": "session_search_sources",
                    "Actual Rows": 3, "Actual Loops": 2,
                    "Plans": [{
                        "Node Type": "Bitmap Index Scan",
                        "Index Name": "uq_session_search_source_event",
                        "Index Cond": "(event_id > $1)",
                    }],
                },
            ],
        }],
    }
    assert sources_scans(plan) == [
        {
            "node": "Index Only Scan", "index": "ix_session_search_sources_event_metadata",
            "index_condition": False, "rows": 231, "loops": 1, "removed_by_filter": 4096,
            "heap_fetches": 4327, "visited": 4327,
        },
        {
            "node": "Bitmap Heap Scan", "index": "uq_session_search_source_event",
            "index_condition": True, "rows": 3, "loops": 2, "removed_by_filter": 0,
            "heap_fetches": None, "visited": 6,
        },
    ]


def test_candidate_bounds_scratch_prefix_is_registered():
    from tests.test_session_content_postgres import SCRATCH_PREFIXES

    assert CB_SCRATCH_PREFIX in SCRATCH_PREFIXES
    assert CB_SCRATCH_PREFIX.startswith("uxc_cb_")
