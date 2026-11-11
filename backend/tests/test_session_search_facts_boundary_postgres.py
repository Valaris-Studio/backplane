# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Facts parity across the tiny/hot cardinality boundary; root native execution."""

import json
from dataclasses import astuple

import pytest
from sqlalchemy import and_, case, delete, func, literal, select, text, update

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.schemas.session_content import TEXT_MEDIA_TYPES
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_latency_postgres import original_eligible_totals
from tests.test_session_search_postgres import pg_inline, receipt_path

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

BODY = b"boundary parity needle"
ANCHOR = "c:facts-boundary"
OTHER_ANCHOR = "c:other-boundary"
SCOPES = (
    SearchScope(EXTRACTOR_VERSION),
    SearchScope(EXTRACTOR_VERSION, channels=frozenset({"tool_output"})),
    SearchScope(EXTRACTOR_VERSION, channels=frozenset({"assistant"})),
    SearchScope(EXTRACTOR_VERSION, channels=frozenset(), tool_alias=True),
    SearchScope(
        EXTRACTOR_VERSION, channels=frozenset(), tool_anchors=frozenset({ANCHOR})
    ),
    SearchScope(
        EXTRACTOR_VERSION, channels=frozenset(), mcp_anchors=frozenset({ANCHOR})
    ),
    SearchScope(
        EXTRACTOR_VERSION,
        failed_anchors=frozenset({ANCHOR}),
        work_anchors=frozenset({ANCHOR}),
    ),
    SearchScope(
        EXTRACTOR_VERSION,
        failed_anchors=frozenset({ANCHOR}),
        work_anchors=frozenset({OTHER_ANCHOR}),
    ),
)
SCENARIOS = (
    ("baseline", None, {}),
    ("pending", Source, {"status": "pending"}),
    ("unavailable", Source, {"status": "unavailable"}),
    ("not_text", Source, {"status": "not_text"}),
    ("old_extractor", Source, {"extractor_version": "previous"}),
    ("stale_digest", Source, {"source_digest": "0" * 64}),
    ("missing_source", Source, None),
    ("null_digest", Content, {"sha256": None}),
    ("unknown_sizes", Content, {"byte_count": None, "original_byte_count": None}),
    ("known_original", Content, {"byte_count": None, "original_byte_count": 47}),
    ("fallback_original", Content, {"byte_count": 23, "original_byte_count": None}),
    ("known_zero", Content, {"byte_count": 0, "original_byte_count": 0}),
    ("recorded_withheld", Content, {"state": "recorded", "coverage": "withheld"}),
    ("binary_media", Content, {"media_type": "image/png"}),
)


def canonical_coverage(rows):
    groups = {}
    for row in rows:
        values = astuple(row) if hasattr(row, "__dataclass_fields__") else tuple(row)
        key = (values[0], values[1], bool(values[2]), values[3] or "pending", False)
        totals = groups.setdefault(key, [0] * 5)
        for index, amount in enumerate(values[5:]):
            totals[index] += int(amount)
    return sorted(((*key, *values) for key, values in groups.items()), key=repr)


async def baseline_coverage(db, session_id):
    # Preserve the original late LEFT JOIN, including pending Sources, then
    # normalize the A decision's missing/pending equivalence after aggregation.
    is_text = case((Content.media_type.in_(TEXT_MEDIA_TYPES), 1), else_=0)
    original_bytes = func.coalesce(Content.original_byte_count, Content.byte_count)
    keys = (Content.state, Content.coverage, is_text, Source.status)
    return canonical_coverage(
        (
            await db.execute(
                select(
                    *keys,
                    literal(False),
                    func.count(),
                    func.coalesce(func.sum(Content.byte_count), 0),
                    func.count(Content.byte_count),
                    func.coalesce(func.sum(original_bytes), 0),
                    func.count(original_bytes),
                )
                .select_from(Content)
                .outerjoin(
                    Source,
                    and_(
                        Source.content_id == Content.id,
                        Source.extractor_version == EXTRACTOR_VERSION,
                        Source.source_digest == Content.sha256,
                    ),
                )
                .where(Content.session_id == session_id)
                .group_by(*keys)
            )
        ).all()
    )


async def require_coherent_graph(db, session_id, population):
    assert (
        await db.scalar(
            select(func.count())
            .select_from(Content)
            .where(Content.session_id == session_id)
        )
        == population
    )
    rows = (
        await db.execute(
            select(
                Source.id,
                Source.session_id,
                Content.session_id,
                Source.chunk_count,
                Source.folded_bytes,
                func.count(Chunk.id),
                func.coalesce(func.sum(Chunk.owned_bytes), 0),
                func.bool_and(Chunk.session_id == Source.session_id),
            )
            .join(Content, Content.id == Source.content_id)
            .outerjoin(Chunk, Chunk.source_id == Source.id)
            .where(Content.session_id == session_id)
            .group_by(Source.id, Content.session_id)
        )
    ).all()
    for (
        source_id,
        source_session,
        content_session,
        count,
        size,
        actual_count,
        actual_size,
        same_session,
    ) in rows:
        assert source_session == content_session == session_id, source_id
        assert (count, size) == (actual_count, actual_size), source_id
        assert same_session is not False, source_id


@pytest.mark.parametrize("population", [0, 1, 32, 33, 34])
@pytest.mark.timeout(90)
async def test_facts_preserve_raw_coverage_and_totals_at_population_boundary(
    pg, tmp_path, population
):
    _, session_id, _ = await pg_inline(pg, [BODY] * max(population, 1))
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
        if population == 0:
            await db.execute(delete(Content).where(Content.session_id == session_id))
        contents = (
            await db.scalars(
                select(Content.id)
                .where(Content.session_id == session_id)
                .order_by(Content.id)
            )
        ).all()
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
                update(Source)
                .where(Source.id == source_id)
                .values(call_anchor=ANCHOR if rank % 2 else OTHER_ANCHOR)
            )
            await db.execute(
                update(Chunk)
                .where(Chunk.source_id == source_id)
                .values(channel=channel)
            )
        await require_coherent_graph(db, session_id, population)

    # Choose deterministic sorted positions; never rewrite IDs or suspend FKs.
    boundary_ranks = list(range(max(0, population - 4), population))
    scenarios = SCENARIOS if population else SCENARIOS[:1]
    async with pg["factory"]() as db:
        await db.execute(text("SET LOCAL statement_timeout='10s'"))
        for index, (name, model, values) in enumerate(scenarios):
            nested = await db.begin_nested()
            try:
                rank = boundary_ranks[index % len(boundary_ranks)] if contents else None
                target = contents[rank] if rank is not None else None
                if model is Source:
                    if values is None:
                        await db.execute(
                            delete(Source).where(Source.content_id == target)
                        )
                    else:
                        await db.execute(
                            update(Source)
                            .where(Source.content_id == target)
                            .values(**values)
                        )
                elif model is Content:
                    await db.execute(
                        update(Content).where(Content.id == target).values(**values)
                    )
                await require_coherent_graph(db, session_id, population)
                expected_coverage = await baseline_coverage(db, session_id)
                observations = []
                for scope in SCOPES:
                    repo = SessionSearchRepository(db)
                    expected_totals = await original_eligible_totals(
                        repo, session_id, scope
                    )
                    facts = await repo.content_facts(session_id, scope)
                    public_totals = await repo.eligible_totals(session_id, scope)
                    xid = await db.scalar(
                        text("SELECT pg_current_xact_id_if_assigned()::text")
                    )
                    observations.append(
                        {
                            "scope": repr(scope),
                            "expected_totals": expected_totals,
                            "facts_totals": facts.eligible_totals,
                            "public_totals": public_totals,
                            "coverage": canonical_coverage(facts.coverage_rows),
                            "snapshot": facts.snapshot,
                            "facts_xid": facts.xid,
                            "transaction_xid": xid,
                        }
                    )
                evidence = {
                    "population": population,
                    "scenario": name,
                    "ordered_content_ids": contents,
                    "target_rank_zero_based": rank,
                    "target_id": target,
                    "expected_coverage": expected_coverage,
                    "observations": observations,
                    "qualification": "Semantic boundary control, not latency or query-shape proof",
                }
                with receipt_path(
                    tmp_path, f"facts-boundary-{population}-{name}.json"
                ).open("x") as output:
                    json.dump(evidence, output, indent=2, default=str)
                    output.write("\n")
                assert sum(row[5] for row in expected_coverage) == population, evidence
                for observed in observations:
                    assert observed["coverage"] == expected_coverage, evidence
                    assert (
                        observed["facts_totals"] == observed["expected_totals"]
                    ), evidence
                    assert (
                        observed["public_totals"] == observed["expected_totals"]
                    ), evidence
                    assert observed["snapshot"], evidence
                    assert (
                        observed["facts_xid"] == observed["transaction_xid"]
                    ), evidence
            finally:
                await nested.rollback()
