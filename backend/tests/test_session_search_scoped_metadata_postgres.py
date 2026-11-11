# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Native work bounds for eligibility in a growing, unrelated population.

Run serially on a disposable database migrated to head, with
SESSION_CAPTURE_TEST_DATABASE_URL and RICH_CAPTURE_REQUIRE_LEGS=1.
"""

import json
import uuid

import pytest
from sqlalchemy import event, func, insert, select, text

from app.models.agent_session import AgentSessionContent
from app.models.session_search import SessionSearchChunk, SessionSearchSource
from app.repositories.session_search import (
    CONTENT_FACTS_POINT_LOOKUP_LIMIT,
    SearchScope,
    SessionSearchRepository,
)
from app.services.session_search import SessionSearchService
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.query_plans.plan_tuple_counts import relation_scans, relation_visits
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


async def clone_foreign_prefix_graph(env, template_content_id, content_id):
    async with env["factory"].begin() as db:
        content = dict(
            (
                await db.execute(
                    select(AgentSessionContent.__table__).where(
                        AgentSessionContent.id == template_content_id
                    )
                )
            )
            .mappings()
            .one()
        )
        source = dict(
            (
                await db.execute(
                    select(SessionSearchSource.__table__).where(
                        SessionSearchSource.content_id == template_content_id
                    )
                )
            )
            .mappings()
            .one()
        )
        chunks = [
            dict(row)
            for row in (
                await db.execute(
                    select(SessionSearchChunk.__table__).where(
                        SessionSearchChunk.source_id == source["id"]
                    )
                )
            ).mappings()
        ]
        assert content["state"] == "available"
        assert source["status"] == "indexed"
        assert source["event_id"] is None
        assert source["source_digest"] == content["sha256"]
        assert source["session_id"] == content["session_id"]
        assert source["chunk_count"] == len(chunks) > 0
        assert source["folded_bytes"] == sum(chunk["owned_bytes"] for chunk in chunks)
        assert all(chunk["session_id"] == source["session_id"] for chunk in chunks)

        source_id = uuid.uuid4()
        await db.execute(
            insert(AgentSessionContent.__table__).values(
                **{
                    **content,
                    "id": content_id,
                    "content_key": uuid.uuid4().hex + uuid.uuid4().hex,
                    "capture_id": uuid.uuid4().hex,
                }
            )
        )
        await db.execute(
            insert(SessionSearchSource.__table__).values(
                **{**source, "id": source_id, "content_id": content_id}
            )
        )
        for chunk in chunks:
            await db.execute(
                insert(SessionSearchChunk.__table__).values(
                    **{**chunk, "id": uuid.uuid4(), "source_id": source_id}
                )
            )
        return {
            "template_content_id": template_content_id,
            "template_source_id": source["id"],
            "session_id": content["session_id"],
            "content_id": content_id,
            "source_id": source_id,
            "chunk_count": len(chunks),
            "folded_bytes": source["folded_bytes"],
        }


@pytest.mark.parametrize(
    "foreign_before_prefix", [False, True], ids=["original", "foreign_before_prefix"]
)
@pytest.mark.timeout(90)
async def test_eligible_metadata_work_stays_with_actual_scoped_sources(
    pg, tmp_path, foreign_before_prefix
):
    scoped_count = 3_072
    first_content = await clone_retained_sources(
        pg, contents=scoped_count - 1, indexed=scoped_count - 1
    )
    foreign_fixtures = []
    foreign_envs = []
    try:
        foreign_sessions = []
        early_foreign_graphs = []
        for foreign_index in range(2):
            fixture = content_postgres_fixture.__wrapped__()
            foreign_fixtures.append(fixture)
            foreign = await fixture.__anext__()
            foreign_envs.append(foreign)
            foreign_content = await clone_retained_sources(
                foreign, contents=0, indexed=0
            )
            async with foreign["factory"]() as db:
                foreign_sessions.append(
                    await db.scalar(
                        select(AgentSessionContent.session_id).where(
                            AgentSessionContent.id == foreign_content
                        )
                    )
                )

            if foreign_before_prefix:
                early_foreign_graphs.append(
                    await clone_foreign_prefix_graph(
                        foreign, foreign_content, uuid.UUID(int=foreign_index)
                    )
                )

        async with pg["factory"].begin() as db:
            session_id = await db.scalar(
                select(AgentSessionContent.session_id).where(
                    AgentSessionContent.id == first_content
                )
            )
            if foreign_before_prefix:
                first_owned_id = await db.scalar(
                    select(AgentSessionContent.id)
                    .where(AgentSessionContent.session_id == session_id)
                    .order_by(AgentSessionContent.id)
                    .limit(1)
                )
                assert [graph["content_id"] for graph in early_foreign_graphs] == [
                    uuid.UUID(int=0),
                    uuid.UUID(int=1),
                ]
                assert all(
                    graph["session_id"] != session_id
                    and graph["content_id"].int < first_owned_id.int
                    for graph in early_foreign_graphs
                )
            source = await db.scalar(
                select(SessionSearchSource).where(
                    SessionSearchSource.content_id == first_content
                )
            )
            chunk = await db.scalar(
                select(SessionSearchChunk).where(
                    SessionSearchChunk.source_id == source.id
                )
            )
            chunk_values = {
                column.name: getattr(chunk, column.name)
                for column in SessionSearchChunk.__table__.columns
            }
            # The writer maintains one session identity and exact Source
            # counters, including zero-byte chunks within a nonempty source.
            source.folded_bytes = 7
            source.chunk_count = 2
            chunk.owned_bytes = chunk.owned_chars = 0
            chunk.folded_text = ""
            db.add(
                SessionSearchChunk(
                    **{
                        **chunk_values,
                        "id": uuid.uuid4(),
                        "ordinal": 1,
                        "owned_bytes": 7,
                        "owned_chars": 7,
                        "folded_text": "needle!",
                    }
                )
            )

        expected = (scoped_count, (scoped_count - 1) * len(BODY) + 7)
        output = receipt_path(
            tmp_path,
            "scoped-metadata-work-foreign-before-prefix.json"
            if foreign_before_prefix
            else "scoped-metadata-work.json",
        )
        receipt = {
            "session_id": session_id,
            "foreign_sessions": foreign_sessions,
            "foreign_before_prefix": foreign_before_prefix,
            "early_foreign_graphs": early_foreign_graphs,
            "expected": expected,
            "observations": [],
            "measurement": "Native EXPLAIN work regression; not latency qualification",
        }
        engine = pg["factory"].kw["bind"]
        for growth in (False, True):
            if growth:
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

            statements = []

            def capture(_conn, _cursor, statement, parameters, _context, _many):
                if statement.lstrip().upper().startswith(("SELECT", "WITH")):
                    statements.append((statement, parameters))

            async with pg["factory"]() as db:
                await db.execute(text("SET TRANSACTION READ ONLY"))
                await db.execute(text("SET LOCAL statement_timeout='10s'"))
                await SessionSearchService(db)._owned_session(
                    pg["workspace_id"], pg["owner_id"], session_id
                )
                scoped = (
                    await db.execute(
                        select(
                            SessionSearchSource.id.label("source_id"),
                            AgentSessionContent.id.label("content_id"),
                        )
                        .select_from(AgentSessionContent)
                        .join(
                            SessionSearchSource,
                            SessionSearchSource.content_id == AgentSessionContent.id,
                        )
                        .where(AgentSessionContent.session_id == session_id)
                    )
                ).all()
                bounds = {
                    "session_search_sources": len({row.source_id for row in scoped}),
                    "agent_session_contents": len({row.content_id for row in scoped}),
                }
                population = {
                    model.__tablename__: await db.scalar(
                        select(func.count()).select_from(model)
                    )
                    for model in (SessionSearchSource, AgentSessionContent)
                }
                index_catalog = (
                    (
                        await db.execute(
                            text(
                                "SELECT c.relname, a.amname, i.indisvalid, i.indisready, "
                                "pg_get_indexdef(c.oid) AS definition "
                                "FROM pg_class c JOIN pg_index i ON i.indexrelid=c.oid "
                                "JOIN pg_am a ON a.oid=c.relam "
                                "WHERE c.oid=to_regclass(:index_name)"
                            ),
                            {
                                "index_name": "public.ix_agent_session_contents_search_session"
                            },
                        )
                    )
                    .mappings()
                    .one_or_none()
                )
                index_catalog = dict(index_catalog) if index_catalog else None
                exact_btree_indexes = set()
                if index_catalog and (
                    index_catalog["amname"] == "btree"
                    and index_catalog["indisvalid"]
                    and index_catalog["indisready"]
                    and index_catalog["definition"]
                    == "CREATE INDEX ix_agent_session_contents_search_session "
                    "ON public.agent_session_contents USING btree (session_id, id)"
                ):
                    exact_btree_indexes.add(index_catalog["relname"])
                repo = SessionSearchRepository(db)
                scope = SearchScope(EXTRACTOR_VERSION)
                original = await original_eligible_totals(repo, session_id, scope)
                event.listen(engine.sync_engine, "before_cursor_execute", capture)
                try:
                    observed = await repo.eligible_totals(session_id, scope)
                finally:
                    event.remove(engine.sync_engine, "before_cursor_execute", capture)
                observation = {
                    "unrelated_population_grown": growth,
                    "population": population,
                    "scoped_identity_bounds": bounds,
                    "original_totals": original,
                    "observed_totals": observed,
                    "statements": statements,
                    "content_index_catalog": index_catalog,
                    "exact_btree_indexes": sorted(exact_btree_indexes),
                }
                receipt["observations"].append(observation)
                output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
                assert original == observed == expected, observation
                assert all(bound == scoped_count for bound in bounds.values()), bounds
                assert len(statements) == 1, "Eligibility uses one statement snapshot"
                sql, parameters = statements[0]
                connection = await db.connection()
                raw = (
                    await connection.exec_driver_sql(
                        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, parameters
                    )
                ).scalar_one()
                # Index-path control: on this small synthetic corpus the planner
                # may read a whole table sequentially; the scoped-work bound is a
                # property of the index paths, which production selectivity keeps
                # the planner on.
                await connection.exec_driver_sql("SET LOCAL enable_seqscan = off")
                controlled_raw = (
                    await connection.exec_driver_sql(
                        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, parameters
                    )
                ).scalar_one()
            plan = json.loads(raw) if isinstance(raw, str) else raw
            controlled_plan = (
                json.loads(controlled_raw)
                if isinstance(controlled_raw, str)
                else controlled_raw
            )
            relations = (*bounds, "session_search_chunks")
            rounded_visits = {
                relation: sum(
                    (node["Actual Rows"] + node.get("Rows Removed by Filter", 0))
                    * node["Actual Loops"]
                    for node in plan_nodes(plan[0]["Plan"])
                    if node.get("Relation Name") == relation
                )
                for relation in relations
            }
            observation.update(
                plan=plan,
                metadata_visits_rounded=rounded_visits,
                default_access_paths={
                    relation: relation_scans(plan[0]["Plan"], relation)
                    for relation in relations
                },
                index_path_control_plan=controlled_plan,
                controlled_access_paths={
                    relation: relation_scans(controlled_plan[0]["Plan"], relation)
                    for relation in relations
                },
            )
            output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
            try:
                observation["default_metadata_visits"] = {
                    relation: relation_visits(
                        plan[0]["Plan"],
                        relation,
                        exact_btree_indexes=exact_btree_indexes,
                    )
                    for relation in relations
                }
                visits = {
                    relation: relation_visits(
                        controlled_plan[0]["Plan"],
                        relation,
                        exact_btree_indexes=exact_btree_indexes,
                    )
                    for relation in relations
                }
            except ValueError as error:
                observation["measurement_error"] = str(error)
                output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")
                raise
            observation["metadata_visits"] = visits
            output.write_text(json.dumps(receipt, indent=2, default=str) + "\n")

        # Preserve both correct answers and plans before asserting the causal
        # bound. Unrelated tenants must not supply validity work for this scope.
        before, after = receipt["observations"]
        assert all(
            after["population"][relation] > before["population"][relation] + 20_000
            for relation in bounds
        ), receipt
        # Unrelated growth must not change the index-path work at all.
        assert after["metadata_visits"] == before["metadata_visits"], (
            before["metadata_visits"],
            after["metadata_visits"],
        )
        # The remainder scan may re-read the materialized content prefix when the
        # planner keys Sources by session alone: each scoped identity at most
        # once, plus that prefix.
        revisit_allowance = {
            "session_search_sources": CONTENT_FACTS_POINT_LOOKUP_LIMIT + 1,
            "agent_session_contents": 0,
        }
        for observation in receipt["observations"]:
            for visits in ("metadata_visits", "default_metadata_visits"):
                assert observation[visits]["session_search_chunks"] == 0, (
                    "Content eligibility must use the writer-maintained Source facts",
                    observation,
                )
            for relation, identities in observation["scoped_identity_bounds"].items():
                bound = identities + revisit_allowance[relation]
                controlled = observation["controlled_access_paths"][relation]
                assert all(scan["index"] is not None for scan in controlled), (
                    f"{relation}: index-path control still scanned sequentially",
                    observation,
                )
                assert observation["metadata_visits"][relation] <= bound, (
                    f"{relation}: {observation['metadata_visits'][relation]} visits "
                    f"for {identities} scoped identities (+{revisit_allowance[relation]}"
                    f" prefix revisits); unrelated growth="
                    f"{observation['unrelated_population_grown']}"
                )
                # The default plan may scan the small corpus sequentially; when it
                # stays on index paths it must honour the same bound.
                default = observation["default_access_paths"][relation]
                if default and all(scan["index"] is not None for scan in default):
                    assert observation["default_metadata_visits"][relation] <= bound, (
                        f"{relation}: default index paths visited "
                        f"{observation['default_metadata_visits'][relation]} > {bound}",
                        observation,
                    )
    finally:
        for fixture in reversed(foreign_fixtures):
            await fixture.aclose()
