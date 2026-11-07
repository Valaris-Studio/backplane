# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Transaction semantics for exact metadata under the session-identity invariant.

These small real-PostgreSQL controls are expected to pass before the metadata
representation changes. Physical-work regressions establish the separate RED.
"""

import asyncio
import uuid
from collections import Counter
from contextlib import asynccontextmanager
from dataclasses import astuple, dataclass

import pytest
from sqlalchemy import delete, insert, select, text, update

from app.models.agent_session import AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from app.repositories.session_search import SearchScope, SessionSearchRepository
from app.services.session_search_text import EXTRACTOR_VERSION
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_latency_postgres import original_eligible_totals
from tests.test_session_search_postgres import pg_inline

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

BARRIER_SECONDS = 5
ADDED_BYTES = 7
CHANGED_DIGEST = "f" * 64


@dataclass(frozen=True)
class MetadataGraph:
    content_session: uuid.UUID
    source_session: uuid.UUID
    chunk_session: uuid.UUID
    content_id: uuid.UUID
    source_id: uuid.UUID
    chunk: dict
    unrelated_sessions: tuple[uuid.UUID, ...]

    @property
    def sessions(self):
        return self.content_session, *self.unrelated_sessions


async def independent_graph(pg):
    sessions, contents = [], []
    for role in ("content", "source", "chunk"):
        _, session_id, acknowledgements = await pg_inline(
            pg, [b"metadata concurrency needle"], native="metadata-" + role
        )
        sessions.append(session_id)
        contents.append(uuid.UUID(acknowledgements[0]["content_id"]))
    async with pg["factory"].begin() as db:
        source = await db.scalar(select(Source).where(Source.content_id == contents[0]))
        chunk = await db.scalar(select(Chunk).where(Chunk.source_id == source.id))
        values = {
            column.name: getattr(chunk, column.name)
            for column in Chunk.__table__.columns
        }
        await db.execute(delete(Source).where(Source.content_id.in_(contents[1:])))
        # Formerly independent identities now share the writer's session;
        # retain the other sessions as controls for unrelated visibility.
        return MetadataGraph(
            sessions[0],
            sessions[0],
            sessions[0],
            contents[0],
            source.id,
            values,
            tuple(sessions[1:]),
        )


@asynccontextmanager
async def bounded_transaction(factory):
    async with factory() as db:
        transaction = await db.begin()
        try:
            await db.execute(text("SET TRANSACTION ISOLATION LEVEL READ COMMITTED"))
            await db.execute(text("SET LOCAL statement_timeout='8s'"))
            yield db, transaction, await db.scalar(text("SELECT pg_backend_pid()"))
        finally:
            if transaction.is_active:
                await asyncio.wait_for(transaction.rollback(), BARRIER_SECONDS)


def normalized_coverage_groups(rows):
    groups = {}
    for row in rows:
        # Owner A classifies missing and explicit pending sources identically.
        key = (*row[:3], "pending" if row[3] is None else row[3], row[4])
        totals = groups.setdefault(key, [0] * 5)
        for position, amount in enumerate(row[5:]):
            totals[position] += amount
    return Counter((*key, *totals) for key, totals in groups.items())


async def metadata_snapshot(db, graph, *, baseline_only=False):
    repo = SessionSearchRepository(db)
    snapshot = {}
    for session_id in graph.sessions:
        expected_totals = await original_eligible_totals(
            repo, session_id, SearchScope(EXTRACTOR_VERSION)
        )
        actual_totals = (
            expected_totals
            if baseline_only
            else await repo.eligible_totals(session_id, SearchScope(EXTRACTOR_VERSION))
        )
        assert actual_totals == expected_totals
        expected_coverage = normalized_coverage_groups(
            tuple(row)
            for row in await db.execute(
                repo._content_coverage_query(session_id, EXTRACTOR_VERSION, set())
            )
        )
        actual_coverage = normalized_coverage_groups(
            astuple(row)
            for row in await repo.content_coverage(session_id, EXTRACTOR_VERSION, set())
        )
        assert actual_coverage == expected_coverage
        snapshot[session_id] = actual_totals, actual_coverage
    return snapshot


async def fresh_snapshot(factory, graph):
    async with bounded_transaction(factory) as (db, _, _):
        return await metadata_snapshot(db, graph)


def assert_eligible(snapshot, graph, *, readable, inserted):
    for session_id in graph.unrelated_sessions:
        assert snapshot[session_id][0] == (0, 0)
    assert snapshot[graph.chunk_session][0] == (
        (1, graph.chunk["owned_bytes"] + ADDED_BYTES * inserted) if readable else (0, 0)
    )


async def insert_chunk(db, graph, *, maintain_counters=True):
    await db.execute(
        insert(Chunk).values(
            **{
                **graph.chunk,
                "id": uuid.uuid4(),
                "ordinal": 1,
                "folded_text": "suffix!",
                "owned_chars": ADDED_BYTES,
                "owned_bytes": ADDED_BYTES,
                "byte_start": 0,
                "segment_byte_start": 0,
                "segment_byte_end": ADDED_BYTES,
                "case_map": None,
            }
        )
    )
    if maintain_counters:
        await db.execute(
            update(Source)
            .where(Source.id == graph.source_id)
            .values(
                folded_bytes=Source.folded_bytes + ADDED_BYTES,
                chunk_count=Source.chunk_count + 1,
            )
        )


async def invalidate(db, graph, mutation):
    if mutation == "source_pending":
        statement = (
            update(Source).where(Source.id == graph.source_id).values(status="pending")
        )
    elif mutation == "source_version":
        statement = (
            update(Source)
            .where(Source.id == graph.source_id)
            .values(extractor_version="previous")
        )
    elif mutation == "content_digest":
        statement = (
            update(Content)
            .where(Content.id == graph.content_id)
            .values(sha256=CHANGED_DIGEST)
        )
    else:
        assert mutation == "content_retraction"
        statement = (
            update(Content)
            .where(Content.id == graph.content_id)
            .values(state="recorded", coverage="withheld_by_policy")
        )
    await db.execute(statement)


async def completed_or_blocked(factory, task, waiter_pid, blocker_pid):
    async def observe():
        while not task.done():
            # Each observation has a fresh statistics snapshot and yields on
            # actual database I/O, without a scheduling sleep or mocked lock.
            async with factory.begin() as db:
                blocked = await db.scalar(
                    text(
                        "SELECT EXISTS (SELECT 1 FROM pg_stat_activity "
                        "WHERE pid=:waiter AND wait_event_type='Lock' "
                        "AND :blocker = ANY(pg_blocking_pids(pid)))"
                    ),
                    {"waiter": waiter_pid, "blocker": blocker_pid},
                )
            if blocked:
                return True
        task.result()
        return False

    return await asyncio.wait_for(observe(), BARRIER_SECONDS)


async def finish(transaction, commit):
    await asyncio.wait_for(
        transaction.commit() if commit else transaction.rollback(), BARRIER_SECONDS
    )


async def cancel_pending(*tasks):
    for task in tasks:
        if task is not None and not task.done():
            task.cancel()
    await asyncio.wait_for(
        asyncio.gather(
            *(task for task in tasks if task is not None), return_exceptions=True
        ),
        BARRIER_SECONDS,
    )


@pytest.mark.parametrize(
    "mutation",
    ["source_pending", "source_version", "content_digest", "content_retraction"],
)
@pytest.mark.parametrize(
    "commit_chunk,commit_invalidation", [(True, True), (True, False), (False, True)]
)
async def test_chunk_insert_and_invalidation_keep_transactional_metadata(
    pg, mutation, commit_chunk, commit_invalidation
):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await fresh_snapshot(factory, graph)
    assert_eligible(original, graph, readable=True, inserted=False)
    async with bounded_transaction(factory) as (writer, write_tx, writer_pid):
        async with bounded_transaction(factory) as (
            invalidator,
            invalidation_tx,
            invalidator_pid,
        ):
            await insert_chunk(writer, graph)
            task = asyncio.create_task(invalidate(invalidator, graph, mutation))
            try:
                blocked = await completed_or_blocked(
                    factory, task, invalidator_pid, writer_pid
                )
                own = await metadata_snapshot(writer, graph)
                assert_eligible(own, graph, readable=True, inserted=True)
                assert await fresh_snapshot(factory, graph) == original
                if not blocked:
                    own = await metadata_snapshot(invalidator, graph)
                    assert_eligible(own, graph, readable=False, inserted=False)

                await finish(write_tx, commit_chunk)
                await asyncio.wait_for(asyncio.shield(task), BARRIER_SECONDS)
                own = await metadata_snapshot(invalidator, graph)
                assert_eligible(own, graph, readable=False, inserted=commit_chunk)
                visible = await fresh_snapshot(factory, graph)
                assert_eligible(visible, graph, readable=True, inserted=commit_chunk)
                assert (
                    visible[graph.content_session][1]
                    == original[graph.content_session][1]
                )
                await finish(invalidation_tx, commit_invalidation)
            finally:
                await cancel_pending(task)

    final = await fresh_snapshot(factory, graph)
    assert_eligible(
        final, graph, readable=not commit_invalidation, inserted=commit_chunk
    )
    assert (
        final[graph.content_session][1] != original[graph.content_session][1]
    ) == commit_invalidation


@pytest.mark.parametrize(
    "mutation",
    ["source_pending", "source_version", "content_digest", "content_retraction"],
)
async def test_chunk_insert_after_uncommitted_invalidation_observes_commit(
    pg, mutation
):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await fresh_snapshot(factory, graph)
    async with bounded_transaction(factory) as (
        invalidator,
        invalidation_tx,
        invalidator_pid,
    ):
        async with bounded_transaction(factory) as (writer, write_tx, writer_pid):
            await invalidate(invalidator, graph, mutation)
            task = asyncio.create_task(insert_chunk(writer, graph))
            try:
                blocked = await completed_or_blocked(
                    factory, task, writer_pid, invalidator_pid
                )
                assert_eligible(
                    await metadata_snapshot(invalidator, graph),
                    graph,
                    readable=False,
                    inserted=False,
                )
                assert await fresh_snapshot(factory, graph) == original
                if not blocked:
                    assert_eligible(
                        await metadata_snapshot(writer, graph),
                        graph,
                        readable=True,
                        inserted=True,
                    )
                await finish(invalidation_tx, True)
                await asyncio.wait_for(asyncio.shield(task), BARRIER_SECONDS)
                assert_eligible(
                    await metadata_snapshot(writer, graph),
                    graph,
                    readable=False,
                    inserted=True,
                )
                assert_eligible(
                    await fresh_snapshot(factory, graph),
                    graph,
                    readable=False,
                    inserted=False,
                )
                await finish(write_tx, True)
            finally:
                await cancel_pending(task)
    assert_eligible(
        await fresh_snapshot(factory, graph), graph, readable=False, inserted=True
    )


@pytest.mark.parametrize("commit_content", [True, False])
async def test_content_then_source_updates_do_not_invert_metadata_locks(
    pg, commit_content
):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await fresh_snapshot(factory, graph)
    async with bounded_transaction(factory) as (content_db, content_tx, content_pid):
        async with bounded_transaction(factory) as (source_db, source_tx, source_pid):
            await invalidate(content_db, graph, "content_digest")
            source_task = asyncio.create_task(
                invalidate(source_db, graph, "source_pending")
            )
            content_task = None
            try:
                await completed_or_blocked(
                    factory, source_task, source_pid, content_pid
                )
                content_task = asyncio.create_task(
                    content_db.execute(
                        update(Source)
                        .where(Source.id == graph.source_id)
                        .values(status="indexed", source_digest=CHANGED_DIGEST)
                    )
                )
                assert await completed_or_blocked(
                    factory, content_task, content_pid, source_pid
                )
                # A Source trigger that waits for Content introduces the other
                # edge of this real cycle; no global lock masks that inversion.
                assert source_task.done(), "Source mutation waits for Content while its Source row blocks the Content transaction"
                source_task.result()
                assert await fresh_snapshot(factory, graph) == original
                await finish(source_tx, True)
                await asyncio.wait_for(asyncio.shield(content_task), BARRIER_SECONDS)
                assert_eligible(
                    await metadata_snapshot(content_db, graph),
                    graph,
                    readable=True,
                    inserted=False,
                )
                assert_eligible(
                    await fresh_snapshot(factory, graph),
                    graph,
                    readable=False,
                    inserted=False,
                )
                await finish(content_tx, commit_content)
            finally:
                await cancel_pending(source_task, content_task)
    assert_eligible(
        await fresh_snapshot(factory, graph),
        graph,
        readable=commit_content,
        inserted=False,
    )
