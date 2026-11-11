# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""First-read aggregate semantics across owned and unrelated population growth.

Requires serial execution on disposable PostgreSQL migrated to head, with
SESSION_CAPTURE_TEST_DATABASE_URL and RICH_CAPTURE_REQUIRE_LEGS=1.
Scan work is retained as observation; metadata 128's constant-bucket bound is
an archived diagnostic of that rejected representation.
"""

import json
import uuid
from dataclasses import astuple

import pytest
from sqlalchemy import and_, case, event, func, select, text

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.schemas.session_content import TEXT_MEDIA_TYPES
from app.services.session_search import SessionSearchService
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import (
    paused_object_indexing as pause_processor_fixture,
)
from tests.test_session_search_backfill_coverage_cost_postgres import (
    BODY,
    clone_retained_sources,
)
from tests.test_session_search_latency_postgres import (
    original_eligible_totals,
    plan_nodes,
)
from tests.test_session_search_postgres import receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


async def original_content_coverage(db, session_id, unverified):
    """20eaade deployed coverage JOIN, including a matching pending Source."""
    current = and_(
        Source.content_id == Content.id,
        Source.extractor_version == EXTRACTOR_VERSION,
        Source.source_digest == Content.sha256,
    )
    classified = (
        select(
            Content.state.label("state"),
            Content.coverage.label("coverage"),
            case((Content.media_type.in_(TEXT_MEDIA_TYPES), 1), else_=0).label(
                "is_text"
            ),
            Source.status.label("index_status"),
            case((Content.id.in_(unverified), 1), else_=0).label("unverified"),
            Content.byte_count.label("stored_bytes"),
            func.coalesce(Content.original_byte_count, Content.byte_count).label(
                "original_bytes"
            ),
        )
        .select_from(Content)
        .outerjoin(Source, current)
        .where(Content.session_id == session_id)
        .subquery()
    )
    keys = [
        classified.c.state,
        classified.c.coverage,
        classified.c.is_text,
        classified.c.index_status,
        classified.c.unverified,
    ]
    rows = await db.execute(
        select(
            *keys,
            func.count(),
            func.coalesce(func.sum(classified.c.stored_bytes), 0),
            func.count(classified.c.stored_bytes),
            func.coalesce(func.sum(classified.c.original_bytes), 0),
            func.count(classified.c.original_bytes),
        ).group_by(*keys)
    )
    return sorted(
        (
            tuple(row[:2]) + (bool(row[2]), row[3], bool(row[4])) + tuple(row[5:])
            for row in rows
        ),
        key=repr,
    )


@pytest.mark.timeout(90)
async def test_first_metadata_aggregates_preserve_semantics_across_population_growth(
    pg, tmp_path
):
    first_content = await clone_retained_sources(pg, contents=3_071, indexed=3_071)
    foreign_fixtures = []
    foreign_envs = []
    try:
        foreign_contents = []
        for _ in range(2):
            fixture = content_postgres_fixture.__wrapped__()
            foreign_fixtures.append(fixture)
            foreign = await fixture.__anext__()
            foreign_envs.append(foreign)
            content_id = await clone_retained_sources(foreign, contents=0, indexed=0)
            foreign_contents.append(content_id)

        async with pg["factory"].begin() as db:
            session_id = await db.scalar(
                select(Content.session_id).where(Content.id == first_content)
            )
            unverified = set(
                await db.scalars(
                    select(Content.id)
                    .where(
                        Content.session_id == session_id, Content.id != first_content
                    )
                    .order_by(Content.id)
                    .limit(2)
                )
            )
        # Each Content/Source/Chunk graph keeps the writer's session identity.
        # Foreign IDs and a nonexistent ID must not become owned coverage.
        unverified.update((*foreign_contents, uuid.uuid4()))
        output = receipt_path(tmp_path, "metadata-aggregate-read-cost.json")
        receipt = {
            "unverified_ids": sorted(unverified),
            "observations": [],
            "interpretation": "First-read semantic/oracle control, no warmup or result cache; scan work observed, not latency qualification",
            "coverage_oracle": "20eaade deployed content_coverage; no terminal-status filter",
            "scan_work_criterion": "Metadata 128 constant-bucket bound archived with the rejected representation; no bound is asserted here",
        }
        engine = pg["factory"].kw["bind"]
        for phase, owned_count, total_count in (
            ("small", 3_072, 3_074),
            ("owned_growth", 8_192, 8_194),
            ("unrelated_growth", 8_192, 28_196),
        ):
            if phase == "owned_growth":
                await clone_retained_sources(pg, contents=5_119, indexed=5_119)
            elif phase == "unrelated_growth":
                for foreign in foreign_envs:
                    await clone_retained_sources(
                        foreign, contents=10_000, indexed=10_000
                    )
            async with pg["factory"].begin() as db:
                for table in (
                    "agent_session_contents",
                    "session_search_sources",
                    "session_search_chunks",
                ):
                    await db.execute(text(f"ANALYZE {table}"))

            observation = {
                "phase": phase,
                "owned_sources": owned_count,
                "fixture_total_sources": total_count,
                "aggregates": {},
            }
            receipt["observations"].append(observation)
            async with pg["factory"]() as db:
                await db.execute(text("SET TRANSACTION READ ONLY"))
                await db.execute(text("SET LOCAL statement_timeout='10s'"))
                await SessionSearchService(db)._owned_session(
                    pg["workspace_id"], pg["owner_id"], session_id
                )
                repo = SessionSearchRepository(db)
                scope = SearchScope(EXTRACTOR_VERSION)
                for name in ("eligible_totals", "content_coverage"):
                    statements = []

                    def capture(_conn, _cursor, sql, params, _context, _many):
                        statements.append((sql, params))

                    measured = {"statements": statements}
                    observation["aggregates"][name] = measured
                    event.listen(engine.sync_engine, "before_cursor_execute", capture)
                    try:
                        if name == "eligible_totals":
                            measured["result"] = await repo.eligible_totals(
                                session_id, scope
                            )
                        else:
                            rows = await repo.content_coverage(
                                session_id, EXTRACTOR_VERSION, unverified
                            )
                            measured["result"] = sorted(
                                (astuple(row) for row in rows), key=repr
                            )
                    except BaseException as error:
                        measured["error_type"] = type(error).__name__
                        raise
                    finally:
                        event.remove(
                            engine.sync_engine, "before_cursor_execute", capture
                        )
                        output.write_text(
                            json.dumps(receipt, indent=2, default=str) + "\n"
                        )

                # Both first calls and their raw answers are preserved before
                # EXPLAIN replays or independent oracle queries touch the graph.
                for measured in observation["aggregates"].values():
                    assert measured[
                        "statements"
                    ], "Read current metadata; do not reuse a process result"
                    measured["plans"] = []
                    measured["scan_visits"] = []
                    for sql, parameters in measured["statements"]:
                        assert sql.lstrip().upper().startswith(("SELECT", "WITH")), sql
                        connection = await db.connection()
                        raw = (
                            await connection.exec_driver_sql(
                                "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql,
                                parameters,
                            )
                        ).scalar_one()
                        plan = json.loads(raw) if isinstance(raw, str) else raw
                        measured["plans"].append(plan)
                        for node in plan_nodes(plan[0]["Plan"]):
                            # Include every relation and intermediate scan. A
                            # replacement table or expanded JSON relation cannot
                            # hide the same population scan under another name.
                            if (
                                "Relation Name" in node
                                or "Scan" in node["Node Type"]
                                or node["Node Type"] == "ProjectSet"
                            ):
                                measured["scan_visits"].append(
                                    {
                                        "node": node["Node Type"],
                                        "relation": node.get("Relation Name"),
                                        "visits": (
                                            node["Actual Rows"]
                                            + node.get("Rows Removed by Filter", 0)
                                            + node.get(
                                                "Rows Removed by Index Recheck", 0
                                            )
                                        )
                                        * node["Actual Loops"],
                                    }
                                )
                        output.write_text(
                            json.dumps(receipt, indent=2, default=str) + "\n"
                        )
                observation["original_eligibility"] = await original_eligible_totals(
                    repo, session_id, scope
                )
                observation["original_coverage"] = await original_content_coverage(
                    db, session_id, unverified
                )
            output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
            assert (
                observation["aggregates"]["eligible_totals"]["result"]
                == (observation["original_eligibility"])
                == (owned_count, owned_count * len(BODY))
            )
            assert (
                observation["aggregates"]["content_coverage"]["result"]
                == (observation["original_coverage"])
            )
            assert (
                sum(row[5] for row in observation["original_coverage"]) == owned_count
            )
            assert (
                sum(row[5] for row in observation["original_coverage"] if row[4]) == 2
            )

        # Retain scan observations for all three first-read semantic controls.
        for observation in receipt["observations"]:
            visits = sum(
                scan["visits"]
                for measured in observation["aggregates"].values()
                for scan in measured["scan_visits"]
            )
            observation["total_scan_visits"] = visits
        output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
    finally:
        for fixture in reversed(foreign_fixtures):
            await fixture.aclose()
