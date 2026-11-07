# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Raw coverage groups and real certificates across the 33-row prefix."""

import json
from dataclasses import astuple

import pytest
from sqlalchemy import event, select, text, update

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.conftest import (
    _empty_iap_claims_cache as claims_cache_fixture,
    _integrations_token_key as integrations_key_fixture,
    content_storage as storage_fixture,
)
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_facts_boundary_postgres import require_coherent_graph
from tests.test_session_search_latency_postgres import original_eligible_totals
from tests.test_session_search_postgres import pg_inline, receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
content_storage = storage_fixture
_empty_iap_claims_cache = claims_cache_fixture
_integrations_token_key = integrations_key_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
BODY = b"split merge needle body"
SCOPES = (
    ("all", SearchScope(EXTRACTOR_VERSION), 34),
    (
        "tool_output",
        SearchScope(EXTRACTOR_VERSION, channels=frozenset({"tool_output"})),
        17,
    ),
)


def coverage_tuples(rows):
    """Sort individual rows without merging or normalizing classification keys."""
    result = []
    for row in rows:
        values = astuple(row) if hasattr(row, "__dataclass_fields__") else tuple(row)
        result.append(
            (
                *values[:2],
                bool(values[2]),
                values[3],
                bool(values[4]),
                *(int(value) for value in values[5:]),
            )
        )
    return sorted(result, key=repr)


@pytest.mark.timeout(90)
async def test_split_groups_are_unique_before_cross_boundary_unverified_reclassification(
    pg, monkeypatch, tmp_path
):
    _, session_id, _ = await pg_inline(
        pg, [BODY] * 34, native="split-merge-reclassification"
    )
    async with pg["factory"].begin() as db:
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == "130"
        assert (
            await db.scalar(
                text(
                    "SELECT count(*) FROM pg_constraint WHERE convalidated AND conname IN "
                    "('fk_session_search_sources_content_session', "
                    "'fk_session_search_chunks_source_session')"
                )
            )
            == 2
        )
        contents = (
            await db.scalars(
                select(Content.id)
                .where(Content.session_id == session_id)
                .order_by(Content.id)
            )
        ).all()
        assert len(contents) == 34
        for rank, content_id in enumerate(contents):
            channel = "tool_output" if rank % 2 else "assistant"
            source_id = await db.scalar(
                select(Source.id).where(Source.content_id == content_id)
            )
            assert source_id is not None
            await db.execute(
                update(Content).where(Content.id == content_id).values(channel=channel)
            )
            await db.execute(
                update(Chunk)
                .where(Chunk.source_id == source_id)
                .values(channel=channel)
            )
        await db.execute(
            update(Content)
            .where(Content.id == contents[0])
            .values(byte_count=None, original_byte_count=47)
        )
        await db.execute(
            update(Content)
            .where(Content.id == contents[33])
            .values(byte_count=0, original_byte_count=0)
        )
        await require_coherent_graph(db, session_id, 34)

    unverified = {contents[0], contents[33]}
    ordinary_bytes = 32 * len(BODY)
    expected_early = [
        (
            "available",
            "captured",
            True,
            "indexed",
            False,
            34,
            ordinary_bytes,
            33,
            ordinary_bytes + 47,
            34,
        )
    ]
    expected_late = sorted(
        [
            (
                "available",
                "captured",
                True,
                "indexed",
                False,
                32,
                ordinary_bytes,
                32,
                ordinary_bytes,
                32,
            ),
            ("available", "captured", True, "indexed", True, 2, 0, 1, 47, 2),
        ],
        key=repr,
    )
    observations = []
    engine = pg["factory"].kw["bind"]
    try:
        for label, scope, expected_sources in SCOPES:
            observation = {"scope": label, "statements": [], "payloads": []}
            observations.append(observation)
            async with pg["factory"]() as db:
                async with db.begin():
                    await db.execute(
                        text(
                            "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY"
                        )
                    )
                    await db.execute(text("SET LOCAL statement_timeout='8s'"))
                    await db.execute(text("SET LOCAL lock_timeout='2s'"))
                    repo = SessionSearchRepository(db)
                    oracle_totals = await original_eligible_totals(
                        repo, session_id, scope
                    )
                    oracle_coverage = coverage_tuples(
                        (
                            await db.execute(
                                repo._content_coverage_query(
                                    session_id, EXTRACTOR_VERSION, unverified
                                )
                            )
                        ).all()
                    )
                    observation["oracle_totals"] = oracle_totals
                    observation["oracle_coverage"] = oracle_coverage
                    assert oracle_totals == (
                        expected_sources,
                        expected_sources * len(BODY),
                    )
                    assert oracle_coverage == expected_late

                    original_execute = db.execute

                    async def execute_and_preserve_result(statement, *args, **kwargs):
                        result = await original_execute(statement, *args, **kwargs)
                        frozen = result.freeze()
                        observation["payloads"].append(frozen().scalar_one())
                        return frozen()

                    def capture(_connection, _cursor, sql, parameters, _context, _many):
                        observation["statements"].append(
                            {"sql": sql, "parameters": parameters}
                        )

                    with monkeypatch.context() as patches:
                        patches.setattr(db, "execute", execute_and_preserve_result)
                        event.listen(
                            engine.sync_engine, "before_cursor_execute", capture
                        )
                        try:
                            totals = await repo.eligible_totals(session_id, scope)
                            reuse = repo._coverage_reuse
                            assert reuse is not None
                            facts = reuse.facts
                            observation["raw_early_rows"] = [
                                astuple(row) for row in facts.coverage_rows
                            ]
                            keys = [
                                (row.state, row.coverage, row.is_text, row.index_status)
                                for row in facts.coverage_rows
                            ]
                            # This assertion precedes any sorting/normalization: a raw
                            # prefix and remainder group with the same key must merge.
                            assert len(keys) == len(set(keys))
                            assert (
                                coverage_tuples(facts.coverage_rows) == expected_early
                            )
                            assert facts.xid is None
                            assert totals == oracle_totals
                            late = await repo.content_coverage(
                                session_id, EXTRACTOR_VERSION, unverified
                            )
                            observation["raw_late_rows"] = [
                                astuple(row) for row in late
                            ]
                            assert (
                                coverage_tuples(late)
                                == oracle_coverage
                                == expected_late
                            )
                            assert repo._coverage_reuse is None
                        finally:
                            event.remove(
                                engine.sync_engine, "before_cursor_execute", capture
                            )

                    # Actual result payloads are frozen and replayed to the original
                    # caller; no certificate is synthesized and no extra SQL is sent.
                    assert len(observation["statements"]) == 2, observation
                    assert len(observation["payloads"]) == 2, observation
                    early, certificate = observation["payloads"]
                    assert early["xid"] is None and certificate["xid"] is None
                    assert (
                        early["snapshot"] == certificate["snapshot"] == facts.snapshot
                    )
                    assert {str(row[0]) for row in certificate["rows"]} == {
                        str(content_id) for content_id in unverified
                    }
                    assert len(certificate["rows"]) == 2
                    assert all(
                        "pg_current_snapshot()" in statement["sql"].lower()
                        for statement in observation["statements"]
                    )
                    assert "group by" not in observation["statements"][1]["sql"].lower()
    finally:
        with receipt_path(tmp_path, "split-merge-reclassification.json").open(
            "x"
        ) as output:
            json.dump(
                {
                    "ordered_content_ids": contents,
                    "unverified_ranks": [0, 33],
                    "unverified_content_ids": sorted(unverified),
                    "body_bytes": len(BODY),
                    "expected_early": expected_early,
                    "expected_late": expected_late,
                    "observations": observations,
                    "qualification": "raw-group uniqueness and real late-certificate semantics; not latency",
                },
                output,
                indent=2,
                default=str,
            )
            output.write("\n")
