# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01H scope-wide metadata cost, on root's disposable migrated PostgreSQL.

These two cases record real plans, not a guessed latency/index-name gate.
Bulk legacy metadata qualifies aggregate bookkeeping, never body search.
The imported PG fixture requires migration126 and owns only synthetic data.
"""

import hashlib
import json
import re
import uuid
from collections import Counter
from contextlib import contextmanager
from pathlib import Path
from time import perf_counter

import pytest
from sqlalchemy import delete, event, insert, select, text, update

from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.services.test_session_search_backfill import BodyIO, driver, receipt, run_id
from tests.test_session_search_backfill_postgres import (
    BODY,
    backfill_pg as backfill_pg_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
    pg as capture_postgres_fixture,
)

backfill_pg = backfill_pg_fixture
paused_object_indexing = paused_object_indexing_fixture
pg = capture_postgres_fixture
pytestmark = [
    pytest.mark.slow, pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
TOTAL_CONTENTS = 2_500
INLINE = "Synthetic inline aggregate control Straße".encode()
BUCKETS = (
    "indexed", "pending_index", "pending_upload", "withheld", "uncaptured",
    "unavailable", "nontext", "available", "eligible",
)
TABLES = (
    "workspaces", "workspace_members", "agent_sessions", "agent_session_contents",
    "agent_session_events", "session_search_sources", "session_search_chunks",
    "session_search_states", "session_search_backfill_runs", "session_search_backfill_claims",
)
BODY_COLUMNS = {"inline_text", "preview", "folded_text", "args", "result", "raw"}
MUTATING_SQL = re.compile(
    r"\b(insert|update|delete|merge|call|copy|create|alter|drop|truncate)\b"
    r"|\bfor\s+(?:no\s+key\s+|key\s+)?(?:update|share)\b", re.IGNORECASE
)


@contextmanager
def capture_selects(engine):
    queries = []

    def observed(_connection, cursor, statement, parameters, _context, many):
        if statement.lstrip().upper().startswith(("SELECT", "WITH")):
            assert not many
            queries.append({
                "sql": statement, "parameters": parameters,
                "columns": [column[0] for column in (cursor.description or ())],
                "returned_rows": cursor.rowcount,
            })

    event.listen(engine.sync_engine, "after_cursor_execute", observed)
    try:
        yield queries
    finally:
        event.remove(engine.sync_engine, "after_cursor_execute", observed)


def plan_nodes(plan):
    yield plan
    for child in plan.get("Plans", []):
        yield from plan_nodes(child)


async def explain_metadata(engine, queries):
    plans, seen = [], set()
    async with engine.connect() as connection:
        # A misplaced SELECT with a mutating function must not gain write
        # permission merely because measurement uses EXPLAIN ANALYZE.
        await connection.exec_driver_sql("SET TRANSACTION READ ONLY")
        for query in queries:
            sql = query["sql"]
            if (
                MUTATING_SQL.search(sql)
                or BODY_COLUMNS.intersection(query["columns"])
                or not any(table in sql for table in TABLES)
            ):
                continue
            signature = (sql, repr(query["parameters"]))
            if signature in seen:
                continue
            seen.add(signature)
            raw = (await connection.exec_driver_sql(
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, query["parameters"]
            )).scalar_one()
            plan = json.loads(raw) if isinstance(raw, str) else raw
            nodes = list(plan_nodes(plan[0]["Plan"]))
            plans.append({
                **query, "plan": plan,
                "observed_indexes": sorted({
                    node["Index Name"] for node in nodes if "Index Name" in node
                }),
                "node_work": [{
                    key: node[key] for key in (
                        "Node Type", "Relation Name", "Actual Rows", "Actual Loops",
                        "Rows Removed by Filter", "Rows Removed by Join Filter",
                        "Shared Hit Blocks", "Shared Read Blocks", "Total Cost",
                    ) if key in node
                } for node in nodes],
            })
    assert plans, "The receipt must include actual metadata SELECT plans"
    return plans


async def analyze_metadata(case):
    async with case.factory.begin() as db:
        version = await db.scalar(text("SELECT version()"))
        for name in TABLES:
            await db.execute(text(f'ANALYZE "{name}"'))
    return version


def assert_no_body_projection(queries):
    for query in queries:
        assert not BODY_COLUMNS.intersection(query["columns"]), query["columns"]


class MetadataFixture:
    def __init__(self, case):
        self.case = case
        self.extra_workspaces = []
        self.workspaces = [case.env["workspace_id"]]
        self.sessions = []
        self.children = 0
        self.source_count = 0
        self.excluded_count = 0
        self.expected = {name: {"count": 0, "bytes": 0} for name in BUCKETS}
        self.session_totals = Counter()
        self.session_bytes = Counter()

    async def initialize(self):
        source = await self.case.source()
        async with self.case.factory.begin() as db:
            content = await db.get(AgentSessionContent, source["content_id"])
            session = await db.get(AgentSession, source["session_id"])
            self.content = {column.name: getattr(content, column.name) for column in content.__table__.columns}
            self.session = {column.name: getattr(session, column.name) for column in session.__table__.columns}
            for number in range(5):
                identity = uuid.uuid4()
                self.extra_workspaces.append(identity)
                self.workspaces.append(identity)
                db.add(Workspace(
                    id=identity, slug="backfill-plans-" + identity.hex,
                    name="Synthetic aggregate workspace", created_by=self.case.env["owner_id"],
                ))
            await db.flush()
            # Workspace5 deliberately has no current owner membership.
            db.add_all([WorkspaceMember(
                workspace_id=identity, user_id=self.case.env["owner_id"], role=WorkspaceRole.owner,
            ) for identity in self.workspaces[1:5]])
            self.sessions.append((source["session_id"], 0, False))
            for workspace_number in range(6):
                if workspace_number:
                    parent = self.new_session(workspace_number, None)
                    db.add(AgentSession(**parent))
                else:
                    parent = self.session
                await db.flush()
                db.add(AgentSession(**self.new_session(workspace_number, parent["id"])))
        self.add_expected("pending_object", 0)
        self.session_totals[source["session_id"]] += 1
        self.session_bytes[source["session_id"]] += len(BODY)

    def new_session(self, workspace_number, parent_id):
        identity = uuid.uuid4()
        values = {
            **self.session, "id": identity, "workspace_id": self.workspaces[workspace_number],
            "native_session_id": "synthetic-metadata-" + identity.hex,
            "parent_session_id": parent_id, "parent_native_session_id": None,
            "mapping_id": None, "board_id": None, "content_count": 0, "content_bytes": 0,
        }
        self.sessions.append((identity, workspace_number, parent_id is not None))
        self.children += int(parent_id is not None and workspace_number != 5)
        return values

    def add_expected(self, kind, workspace_number):
        self.source_count += 1
        if workspace_number == 5:
            self.excluded_count += 1
            return
        # Explicit fixture groups define the oracle; do not call the production
        # classifier or use its query result as the expected count.
        buckets, size = {
            "indexed_inline": (("available", "indexed", "eligible"), len(INLINE)),
            "stale_inline": (("available", "pending_index", "eligible"), len(INLINE)),
            "pending_inline": (("available", "pending_index", "eligible"), len(INLINE)),
            "pending_object": (("available", "pending_index", "eligible"), len(BODY)),
            "unknown_object": (("available", "pending_index", "eligible"), None),
            "pending_upload": (("pending_upload",), len(BODY)),
            "withheld": (("withheld",), None),
            "uncaptured": (("uncaptured",), 17),
            "source_unavailable": (("unavailable",), 19),
            "nontext": (("available", "nontext"), len(BODY)),
            "terminal_missing": (("available", "unavailable"), len(BODY)),
        }[kind]
        for name in buckets:
            bucket = self.expected[name]
            bucket["count"] += 1
            bucket["bytes"] = None if size is None or bucket["bytes"] is None else bucket["bytes"] + size

    def content_values(self, kind, session_id, workspace_number, identity=None):
        identity = identity or uuid.uuid4()
        values = {
            **self.content, "id": identity, "session_id": session_id,
            "workspace_id": self.workspaces[workspace_number],
            "content_key": hashlib.sha256(identity.bytes).hexdigest(),
            "source_order": self.source_count + 1, "preview": None,
        }
        if kind.endswith("inline"):
            values.update(
                inline_text=INLINE.decode(), byte_count=len(INLINE), sha256=hashlib.sha256(INLINE).hexdigest(),
                storage_backend=None, storage_key=None, delivery="inline", chunk_count=None,
            )
        elif kind == "unknown_object":
            values.update(byte_count=None)
        elif kind == "pending_upload":
            values.update(state="pending", storage_key=None, available_at=None)
        elif kind in {"withheld", "uncaptured", "source_unavailable"}:
            coverage, reason, size = {
                "withheld": ("withheld_by_policy", "content_level", None),
                "uncaptured": ("collection_failed", "parse_error", 17),
                "source_unavailable": ("source_unavailable", "file_missing", 19),
            }[kind]
            values.update(
                state="recorded", coverage=coverage, coverage_reason=reason,
                declared_coverage=coverage, declared_coverage_reason=reason, delivery="none",
                byte_count=None, original_byte_count=size, sha256=None,
                storage_backend=None, storage_key=None, available_at=None,
            )
        elif kind == "nontext":
            values.update(media_type="application/octet-stream", channel="attachment")
        elif kind == "terminal_missing":
            values.update(storage_key="synthetic-missing/" + identity.hex)
        self.add_expected(kind, workspace_number)
        self.session_totals[session_id] += 1
        self.session_bytes[session_id] += values["byte_count"] or 0
        return values

    async def seed_small_controls(self):
        kinds = (
            "indexed_inline", "stale_inline", "pending_inline", "pending_object", "unknown_object",
            "pending_upload", "withheld", "uncaptured", "source_unavailable", "nontext", "terminal_missing",
        )
        indexed, missing, stale = [], [], []
        async with self.case.factory.begin() as db:
            for workspace_number in range(6):
                local_sessions = [row[0] for row in self.sessions if row[1] == workspace_number]
                for number, kind in enumerate(kinds):
                    values = self.content_values(kind, local_sessions[number % 2], workspace_number)
                    db.add(AgentSessionContent(**values))
                    if workspace_number != 5:
                        if kind in {"indexed_inline", "stale_inline"}:
                            indexed.append(values["id"])
                        if kind == "stale_inline":
                            stale.append(values["id"])
                        if kind == "terminal_missing":
                            missing.append(values["id"])
            await db.flush()
            for identity in indexed:
                assert await SessionSearchIndexWriter(db).index_source("content", identity) == "indexed"
            await db.execute(update(SessionSearchSource).where(
                SessionSearchSource.content_id.in_(stale)
            ).values(extractor_version="synthetic-prior-extractor"))
            await self.sync_session_counters(db)
        for identity in missing:
            prepared = await SessionSearchObjectProcessor(self.case.factory).prepare_source(identity)
            assert prepared.outcome == "missing_object"
            async with self.case.factory.begin() as db:
                assert await SessionSearchIndexWriter(db).index_prepared_source(prepared) == "unavailable"

    async def grow_to_scale(self):
        kinds = (
            "pending_inline", "pending_object", "unknown_object", "pending_upload",
            "withheld", "uncaptured", "source_unavailable", "nontext",
        )
        rows, new_sessions = [], []
        initial = self.source_count
        for ordinal in range(TOTAL_CONTENTS - initial):
            workspace_number = ordinal % 6
            if ordinal % 10 == 0:
                parent = next(row[0] for row in self.sessions if row[1] == workspace_number and not row[2])
                session = self.new_session(workspace_number, parent if ordinal % 20 == 0 else None)
                new_sessions.append(session)
            session_id = next(row[0] for row in reversed(self.sessions) if row[1] == workspace_number)
            rows.append(self.content_values(kinds[ordinal % len(kinds)], session_id, workspace_number))
        async with self.case.factory.begin() as db:
            await db.execute(insert(AgentSession), new_sessions)
            await db.execute(insert(AgentSessionContent), rows)
            await self.sync_session_counters(db)

    async def sync_session_counters(self, db):
        await db.execute(update(AgentSession), [{
            "id": identity, "content_count": count, "content_bytes": self.session_bytes[identity],
        } for identity, count in self.session_totals.items()])

    def assert_coverage(self, value):
        actual = value["coverage"]
        for name in BUCKETS:
            assert actual[name] == self.expected[name], (name, actual[name], self.expected[name])
        assert actual["eligible_count"] == self.expected["eligible"]["count"]
        assert actual["owner_not_member_count"] == self.excluded_count
        assert actual["child_metadata_count"] == self.children
        assert actual["extractor_version"] == EXTRACTOR_VERSION
        assert actual["index_ready"] is False
        assert actual["observed_from"] and actual["observed_at"]


@pytest.fixture
async def plan_fixture(backfill_pg, monkeypatch, tmp_path, request):
    fixture = MetadataFixture(backfill_pg)
    fixture.io = BodyIO(monkeypatch)
    fixture.evidence = {"case": request.node.name, "observations": []}
    try:
        yield fixture
    finally:
        try:
            async with backfill_pg.factory.begin() as db:
                if fixture.extra_workspaces:
                    await db.execute(delete(Workspace).where(Workspace.id.in_(fixture.extra_workspaces)))
        finally:
            fixture.evidence["test_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            (tmp_path / "backfill-plans-receipt.json").write_text(
                json.dumps(fixture.evidence, indent=2, default=str) + "\n"
            )


async def test_postgres_scope_aggregate_is_fresh_constant_query_count_and_body_free(plan_fixture):
    fixture, case = plan_fixture, plan_fixture.case
    engine = case.factory.kw["bind"]
    await fixture.initialize()
    await fixture.seed_small_controls()
    await analyze_metadata(case)
    fixture.io.clear()
    with capture_selects(engine) as start_queries:
        fixture.evidence["start_queries"] = start_queries
        started = await case.start()
    fixture.evidence["start"] = started
    fixture.assert_coverage(started)
    assert fixture.io.stats == fixture.io.reads == []
    with capture_selects(engine) as small_queries:
        fixture.evidence["small_queries"] = small_queries
        small = receipt(await driver(case.factory).status(run_id(started)))
    fixture.evidence["small_status"] = small
    fixture.evidence["small_expected_coverage"] = json.loads(json.dumps(fixture.expected))
    fixture.assert_coverage(small)
    small_count = fixture.source_count
    small_sessions = len(fixture.sessions)
    assert_no_body_projection(start_queries + small_queries)
    fixture.evidence["small_plans"] = await explain_metadata(engine, start_queries + small_queries)
    await fixture.grow_to_scale()
    assert fixture.source_count == TOTAL_CONTENTS
    version = await analyze_metadata(case)
    fixture.io.clear()
    start = perf_counter()
    with capture_selects(engine) as large_queries:
        fixture.evidence["large_queries"] = large_queries
        large = receipt(await driver(case.factory).status(run_id(started)))
    elapsed_ms = (perf_counter() - start) * 1000
    fixture.evidence.update({
        "database": version, "small_source_count": small_count, "large_source_count": fixture.source_count,
        "small_session_count": small_sessions, "large_session_count": len(fixture.sessions),
        "workspace_count": len(fixture.workspaces), "owner_not_member_source_count": fixture.excluded_count,
        "large_status": large, "large_expected_coverage": fixture.expected,
        "large_status_elapsed_ms_observation_only": elapsed_ms,
        "status_stat_calls": len(fixture.io.stats), "status_read_calls": len(fixture.io.reads),
    })
    plans = await explain_metadata(engine, large_queries)
    fixture.evidence["plans"] = plans
    fixture.assert_coverage(large)
    assert fixture.io.stats == fixture.io.reads == []
    assert len(fixture.sessions) > small_sessions
    assert len(large_queries) == len(small_queries), "Scope coverage must not add per-session queries"
    assert_no_body_projection(start_queries + small_queries + large_queries)
    content_plans = [plan for plan in plans if "agent_session_contents" in plan["sql"]]
    assert content_plans
    assert all(any("Aggregate" in node["Node Type"] for node in plan["node_work"]) for plan in content_plans), (
        "Status must aggregate metadata in SQL, not materialize every source for a Python loop"
    )


async def test_postgres_discovery_candidate_cap_precedes_revoked_membership_filter(plan_fixture):
    fixture, case = plan_fixture, plan_fixture.case
    source = await case.source()
    excluded_workspace = uuid.uuid4()
    fixture.extra_workspaces.append(excluded_workspace)
    eligible_id = uuid.UUID(int=(1 << 128) - 1)
    excluded_session = uuid.uuid4()
    async with case.factory.begin() as db:
        original = await db.get(AgentSessionContent, source["content_id"])
        content = {column.name: getattr(original, column.name) for column in original.__table__.columns}
        root = await db.get(AgentSession, source["session_id"])
        session = {column.name: getattr(root, column.name) for column in root.__table__.columns}
        db.add(Workspace(
            id=excluded_workspace, slug="backfill-excluded-" + excluded_workspace.hex,
            name="Synthetic excluded workspace", created_by=case.env["owner_id"],
        ))
        await db.flush()
        db.add(AgentSession(**{
            **session, "id": excluded_session, "workspace_id": excluded_workspace,
            "native_session_id": "excluded-" + excluded_session.hex, "mapping_id": None, "board_id": None,
            "parent_session_id": None, "parent_native_session_id": None,
            "content_count": TOTAL_CONTENTS, "content_bytes": TOTAL_CONTENTS * len(BODY),
        }))
        await db.flush()
        await db.delete(original)
        await db.flush()
        db.add(AgentSessionContent(**{
            **content, "id": eligible_id, "content_key": hashlib.sha256(eligible_id.bytes).hexdigest(),
        }))
        excluded = [{
            **content, "id": uuid.UUID(int=ordinal), "workspace_id": excluded_workspace,
            "session_id": excluded_session, "content_key": hashlib.sha256(uuid.UUID(int=ordinal).bytes).hexdigest(),
            "source_order": ordinal,
        } for ordinal in range(1, TOTAL_CONTENTS + 1)]
        await db.execute(insert(AgentSessionContent), excluded)
    positive = await case.env["client"].get(f"{source['path']}/contents/{eligible_id}/body")
    assert positive.status_code == 200 and positive.json()["text"].encode() == BODY
    version = await analyze_metadata(case)
    fixture.io.clear()
    started = await case.start()
    fixture.evidence.update({
        "database": version, "excluded_content_rows": TOTAL_CONTENTS, "eligible_content_rows": 1,
        "ordering": "All excluded UUID integers1..2500 precede the eligible maximum UUID", "start": started,
    })
    assert started["coverage"]["owner_not_member_count"] == TOTAL_CONTENTS
    assert started["coverage"]["pending_index"] == {"count": 1, "bytes": len(BODY)}
    engine = case.factory.kw["bind"]
    passes, queries = [], []
    fixture.evidence.update({"passes": passes, "queries": queries})
    for _ in range(4):
        with capture_selects(engine) as captured:
            value = await case.step(started)
        passes.append(value)
        queries.extend(captured)
        measured = value["pass"]
        fixture.evidence.update({"stat_calls": len(fixture.io.stats), "read_calls": len(fixture.io.reads)})
        assert 0 <= measured["candidate_keys_examined"] <= 200
        assert measured["sources_attempted"] == 0
        assert measured["read_calls"] == measured["stat_calls"] == 0
        assert fixture.io.stats == fixture.io.reads == []
        if measured["candidate_keys_examined"]:
            break
    assert 0 < measured["candidate_keys_examined"] <= 200
    assert value["progress"]["discovery_complete"] is False
    assert_no_body_projection(queries)
    async with case.factory.begin() as db:
        assert await db.scalar(select(SessionSearchSource.id).where(
            SessionSearchSource.content_id == eligible_id
        )) is None
    plans = await explain_metadata(engine, queries)
    fixture.evidence["plans"] = plans
    candidates = [plan for plan in plans if (
        "agent_session_contents" in plan["sql"]
        and {"id", "source_id", "content_id"}.intersection(plan["columns"])
        and not any("Aggregate" in node["Node Type"] for node in plan["node_work"])
    )]
    assert candidates, "Record the actual bounded content discovery SELECT, not just aggregate plans"
    for plan in candidates:
        assert plan["plan"][0]["Plan"]["Actual Rows"] <= 200
