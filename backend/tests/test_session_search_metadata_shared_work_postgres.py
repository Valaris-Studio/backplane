# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Unchanged, read-only owner requests should share live metadata validation.

This measures executed relation visits, not latency. EXPLAIN replays are retained
separately from the real request. Freshness-changing requests belong to the
transaction controls and must still perform the required late read.
"""

import json

import pytest
from sqlalchemy import event, select, text

from app.models.agent_session import AgentSessionContent as Content
from app.repositories.session_search import CONTENT_FACTS_POINT_LOOKUP_LIMIT
from app.schemas.session_search import SessionSearchRequest
from app.services.session_search import SessionSearchService
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_backfill_coverage_cost_postgres import (
    BODY,
    clone_retained_sources,
)
from tests.query_plans.plan_tuple_counts import relation_scans
from tests.test_session_search_postgres import receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


@pytest.mark.timeout(90)
async def test_unchanged_owner_request_does_not_repeat_metadata_validation(
    pg, tmp_path, monkeypatch
):
    count = 3_072
    content_id = await clone_retained_sources(pg, contents=count - 1, indexed=count - 1)
    engine = pg["factory"].kw["bind"]
    statements = []
    phase = None

    def capture(_connection, _cursor, sql, parameters, _context, _many):
        if phase and sql.lstrip().upper().startswith(("SELECT", "WITH")):
            statements.append({"phase": phase, "sql": sql, "parameters": parameters})

    for name in ("_snapshot", "_coverage"):
        original = getattr(SessionSearchService, name)

        def wrap(method, label):
            async def measured(self, *args, **kwargs):
                nonlocal phase
                assert phase is None
                phase = label
                try:
                    return await method(self, *args, **kwargs)
                finally:
                    phase = None

            return measured

        monkeypatch.setattr(SessionSearchService, name, wrap(original, name))

    evidence = {
        "measurement": "Causal relation visits; replay plans are not latency proof",
        "scoped_sources": count,
        "statements": statements,
    }
    output = receipt_path(tmp_path, "shared-metadata-work.json")
    async with pg["factory"]() as db:
        await db.execute(text("SET TRANSACTION READ ONLY"))
        await db.execute(text("SET LOCAL statement_timeout='10s'"))
        assert await db.scalar(text("SHOW work_mem")) == "64MB"
        session_id = await db.scalar(
            select(Content.session_id).where(Content.id == content_id)
        )
        snapshot_sql = text(
            "SELECT current_setting('transaction_isolation') isolation, "
            "pg_current_snapshot()::text snapshot, "
            "pg_current_xact_id_if_assigned()::text xid"
        )
        before = dict((await db.execute(snapshot_sql)).mappings().one())
        event.listen(engine.sync_engine, "before_cursor_execute", capture)
        try:
            page = await SessionSearchService(db).search(
                pg["workspace_id"],
                pg["owner_id"],
                session_id,
                SessionSearchRequest(q="needle", limit=20),
            )
        finally:
            event.remove(engine.sync_engine, "before_cursor_execute", capture)
        after = dict((await db.execute(snapshot_sql)).mappings().one())
        evidence.update(before=before, after=after, page=page.model_dump(mode="json"))
        output.write_text(json.dumps(evidence, indent=2, default=str) + "\n")
        assert (
            before
            == after
            == {
                "isolation": "read committed",
                "snapshot": before["snapshot"],
                "xid": None,
            }
        ), evidence
        assert len(page.items) == 20
        assert page.eligible_bytes == count * len(BODY)
        assert page.coverage.indexed.count == count
        assert page.coverage.pending_index.count == 0

        connection = await db.connection()

        async def replay(label):
            visits = {"session_search_sources": 0, "agent_session_contents": 0}
            paths = {relation: [] for relation in visits}
            for statement in statements:
                raw = (
                    await connection.exec_driver_sql(
                        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + statement["sql"],
                        statement["parameters"],
                    )
                ).scalar_one()
                plan = json.loads(raw) if isinstance(raw, str) else raw
                statement[label + "_plan"] = plan
                for relation in visits:
                    scans = relation_scans(plan[0]["Plan"], relation)
                    visits[relation] += sum(scan["visited"] for scan in scans)
                    paths[relation].extend(scans)
            return visits, paths

        default_visits, default_paths = await replay("replay")
        # Index-path control: on this small synthetic corpus the planner may read a
        # whole table sequentially; the shared-work bound is a property of the
        # index paths, which production selectivity keeps the planner on.
        await connection.exec_driver_sql("SET LOCAL enable_seqscan = off")
        visits, controlled_paths = await replay("index_path_control")
        evidence.update(
            default_metadata_visits=default_visits,
            default_access_paths=default_paths,
            metadata_visits=visits,
            controlled_access_paths=controlled_paths,
        )
        # Preserve any bounded branch probe; the entire live population must
        # not be validated again when the request's snapshot is unchanged. The
        # remainder scan may re-read the materialized content prefix when the
        # planner keys it by session alone, so each scoped Source is visited at
        # most once plus that prefix.
        bounds = {
            "session_search_sources": count + CONTENT_FACTS_POINT_LOOKUP_LIMIT + 1,
            "agent_session_contents": count + 2_049,
        }
        evidence["bounds"] = bounds
        output.write_text(json.dumps(evidence, indent=2, default=str) + "\n")
        for relation, bound in bounds.items():
            assert all(
                scan["index"] is not None for scan in controlled_paths[relation]
            ), f"{relation}: index-path control still scanned sequentially: {evidence}"
            assert (
                visits[relation] <= bound
            ), f"{relation}: {visits[relation]} visits exceed shared-work bound {bound}"
            # The default plan may scan the small corpus sequentially; when it
            # stays on index paths it must honour the same bound.
            if default_paths[relation] and all(
                scan["index"] is not None for scan in default_paths[relation]
            ):
                assert default_visits[relation] <= bound, (
                    f"{relation}: default index paths visited {default_visits[relation]}"
                    f" > {bound}: {evidence}"
                )


def test_relation_scans_name_index_paths_and_filter_work():
    from tests.query_plans.plan_tuple_counts import relation_scans

    plan = {
        "Node Type": "Aggregate",
        "Plans": [
            {
                "Node Type": "Seq Scan", "Relation Name": "session_search_sources",
                "Actual Rows": 3039, "Actual Loops": 1, "Rows Removed by Filter": 20037,
                "Filter": "((content_id IS NOT NULL) AND (session_id = $1))",
            },
            {
                "Node Type": "Bitmap Heap Scan", "Relation Name": "session_search_sources",
                "Actual Rows": 3039, "Actual Loops": 1,
                "Recheck Cond": "((session_id = $1) AND (content_id > $2))",
                "Plans": [{
                    "Node Type": "Bitmap Index Scan",
                    "Index Name": "ix_session_search_sources_content_metadata",
                    "Index Cond": "((session_id = $1) AND (content_id > $2))",
                }],
            },
            {
                "Node Type": "Index Only Scan", "Relation Name": "agent_session_contents",
                "Index Name": "ix_agent_session_contents_search_session",
                "Actual Rows": 1, "Actual Loops": 33, "Heap Fetches": 0,
                "Index Cond": "(session_id = $1)",
            },
        ],
    }
    assert relation_scans(plan, "session_search_sources") == [
        {
            "node": "Seq Scan", "index": None, "index_condition": False, "rows": 3039,
            "loops": 1, "removed_by_filter": 20037, "heap_fetches": None, "visited": 23076,
        },
        {
            "node": "Bitmap Heap Scan", "index": "ix_session_search_sources_content_metadata",
            "index_condition": True, "rows": 3039, "loops": 1, "removed_by_filter": 0,
            "heap_fetches": None, "visited": 3039,
        },
    ]
    assert relation_scans(plan, "agent_session_contents") == [{
        "node": "Index Only Scan", "index": "ix_agent_session_contents_search_session",
        "index_condition": True, "rows": 1, "loops": 33, "removed_by_filter": 0,
        "heap_fetches": 0, "visited": 33,
    }]
    assert relation_scans(plan, "session_search_chunks") == []
