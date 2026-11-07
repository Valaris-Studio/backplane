# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Small transaction-edge controls on a serial, disposable native database.

Preserve the live-query baseline's successful transaction outcomes independently
of the metadata representation. The TRUNCATE cases refuse a database containing
any other fixture's chunks. Rejected migration-128 storage assertions and native
failure evidence are retained in the private qualification archive.
"""

import asyncio
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.exc import DBAPIError

from app.models.agent_session import AgentSession, AgentSessionContent as Content
from app.models.session_search import SessionSearchChunk as Chunk
from app.models.session_search import SessionSearchSource as Source
from tests.test_session_content_postgres import pg as content_postgres_fixture
from tests.test_session_search import paused_object_indexing as pause_processor_fixture
from tests.test_session_search_metadata_concurrency_postgres import (
    BARRIER_SECONDS,
    ADDED_BYTES,
    CHANGED_DIGEST,
    assert_eligible,
    bounded_transaction,
    cancel_pending,
    completed_or_blocked,
    finish,
    fresh_snapshot,
    independent_graph,
    insert_chunk,
    invalidate,
    metadata_snapshot,
)

pg = content_postgres_fixture
paused_object_indexing = pause_processor_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


async def committed_snapshot(factory, graph, *, baseline_only=False):
    async with bounded_transaction(factory) as (db, _, _):
        return await metadata_snapshot(db, graph, baseline_only=baseline_only)


@asynccontextmanager
async def repeatable_read_transaction(factory):
    async with factory() as db:
        transaction = await db.begin()
        try:
            await db.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            await db.execute(text("SET LOCAL statement_timeout='8s'"))
            yield db, transaction
        finally:
            if transaction.is_active:
                await finish(transaction, False)


async def truncate_owned_chunks(db, graph, *, maintain_counters=True):
    # TRUNCATE itself requires this lock. Taking it before the ownership check
    # prevents deleting a concurrent fixture's newly inserted chunk.
    await db.execute(text("LOCK TABLE session_search_chunks IN ACCESS EXCLUSIVE MODE"))
    assert (
        set(await db.scalars(select(Chunk.id))) == {graph.chunk["id"]}
    ), "TRUNCATE requires a serial disposable database containing only this fixture's chunk"
    await db.execute(text("TRUNCATE TABLE session_search_chunks"))
    if maintain_counters:
        await db.execute(
            update(Source)
            .where(Source.id == graph.source_id)
            .values(folded_bytes=0, chunk_count=0)
        )


@pytest.mark.parametrize("commit_outer", [True, False])
async def test_savepoint_rollback_restores_pending_metadata(pg, commit_outer):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await committed_snapshot(factory, graph)
    async with bounded_transaction(factory) as (db, transaction, _):
        await insert_chunk(db, graph)
        outer = await metadata_snapshot(db, graph)
        assert_eligible(outer, graph, readable=True, inserted=True)
        nested = await db.begin_nested()
        await invalidate(db, graph, "content_digest")
        await invalidate(db, graph, "source_pending")
        assert_eligible(
            await metadata_snapshot(db, graph), graph, readable=False, inserted=True
        )
        assert await fresh_snapshot(factory, graph) == original
        await nested.rollback()
        assert await metadata_snapshot(db, graph) == outer
        await finish(transaction, commit_outer)
    final = await committed_snapshot(factory, graph)
    assert_eligible(final, graph, readable=True, inserted=commit_outer)
    assert final[graph.content_session][1] == original[graph.content_session][1]


async def test_savepoint_rollback_restores_already_flushed_metadata(pg):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await committed_snapshot(factory, graph)
    async with bounded_transaction(factory) as (db, transaction, _):
        nested = await db.begin_nested()
        await insert_chunk(db, graph)
        await db.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
        assert_eligible(
            await metadata_snapshot(db, graph), graph, readable=True, inserted=True
        )
        assert await fresh_snapshot(factory, graph) == original
        await nested.rollback()
        assert await metadata_snapshot(db, graph) == original
        await finish(transaction, True)
    assert await committed_snapshot(factory, graph) == original


@pytest.mark.parametrize(
    "deleted",
    ["content", "source", "content_session", "source_session", "chunk_session"],
)
async def test_cascading_delete_removes_metadata_in_the_same_commit(pg, deleted):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await committed_snapshot(factory, graph)
    model, identity = {
        "content": (Content, graph.content_id),
        "source": (Source, graph.source_id),
        "content_session": (AgentSession, graph.content_session),
        "source_session": (AgentSession, graph.source_session),
        "chunk_session": (AgentSession, graph.chunk_session),
    }[deleted]
    async with bounded_transaction(factory) as (db, transaction, _):
        await db.execute(delete(model).where(model.id == identity))
        own = await metadata_snapshot(db, graph)
        assert_eligible(own, graph, readable=False, inserted=False)
        assert await fresh_snapshot(factory, graph) == original
        await finish(transaction, True)
    assert await committed_snapshot(factory, graph) == own


@pytest.mark.parametrize("commit_truncate", [True, False])
async def test_truncate_reads_empty_chunks_before_commit_and_restores_on_rollback(
    pg, commit_truncate
):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    original = await committed_snapshot(factory, graph)
    async with bounded_transaction(factory) as (db, transaction, _):
        await truncate_owned_chunks(db, graph)
        own = await metadata_snapshot(db, graph)
        assert_eligible(own, graph, readable=False, inserted=False)
        assert own[graph.content_session][1] == original[graph.content_session][1]
        await finish(transaction, commit_truncate)
    assert await committed_snapshot(factory, graph) == (
        own if commit_truncate else original
    )


async def test_baseline_repeatable_read_empty_source_allows_raw_chunk_commit(pg):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    async with factory.begin() as db:
        await db.execute(delete(Chunk).where(Chunk.id == graph.chunk["id"]))
    # Preserve the original successful raw-DML outcome as a baseline control.
    # This writer deliberately omits Source counter maintenance, so it cannot
    # qualify the facts path's supported writer contract.
    original = await committed_snapshot(factory, graph, baseline_only=True)
    assert_eligible(original, graph, readable=False, inserted=False)
    async with repeatable_read_transaction(factory) as (stale, stale_tx):
        assert await metadata_snapshot(stale, graph, baseline_only=True) == original
        async with bounded_transaction(factory) as (writer, write_tx, _):
            await insert_chunk(writer, graph, maintain_counters=False)
            await finish(write_tx, True)
        await invalidate(stale, graph, "source_pending")
        assert_eligible(
            await metadata_snapshot(stale, graph, baseline_only=True),
            graph,
            readable=False,
            inserted=False,
        )
        # The original live query allows this transaction to commit. A query
        # repair must not add a serialization failure or require a retry.
        await finish(stale_tx, True)
    final = await committed_snapshot(factory, graph, baseline_only=True)
    assert final[graph.chunk_session][0] == (0, 0)


@pytest.mark.parametrize("baseline_only", [True, False], ids=["baseline", "candidate"])
async def test_repeatable_read_counter_writer_has_same_source_write_conflict(
    pg, baseline_only
):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    async with factory.begin() as db:
        await db.execute(delete(Chunk).where(Chunk.id == graph.chunk["id"]))
        await db.execute(
            update(Source)
            .where(Source.id == graph.source_id)
            .values(folded_bytes=0, chunk_count=0)
        )
    original = await committed_snapshot(factory, graph, baseline_only=baseline_only)
    assert_eligible(original, graph, readable=False, inserted=False)
    async with repeatable_read_transaction(factory) as (stale, stale_tx):
        assert (
            await metadata_snapshot(stale, graph, baseline_only=baseline_only)
            == original
        )
        async with bounded_transaction(factory) as (writer, write_tx, _):
            await insert_chunk(writer, graph)
            await finish(write_tx, True)
        # Maintaining counters writes this same Source row. Both read paths
        # inherit PostgreSQL's RR write/write conflict from the writer contract.
        with pytest.raises(DBAPIError) as conflict:
            await invalidate(stale, graph, "source_pending")
        assert getattr(conflict.value.orig, "sqlstate", None) == "40001"
        await finish(stale_tx, False)
    final = await committed_snapshot(factory, graph, baseline_only=baseline_only)
    assert final[graph.chunk_session][0] == (1, ADDED_BYTES)


async def test_early_immediate_constraints_allow_later_base_dml_without_deadlock(pg):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    async with bounded_transaction(factory) as (first, first_tx, first_pid):
        async with bounded_transaction(factory) as (second, second_tx, second_pid):
            await invalidate(first, graph, "content_digest")
            await first.execute(text("SET CONSTRAINTS ALL IMMEDIATE"))
            source_task = asyncio.create_task(
                invalidate(second, graph, "source_pending")
            )
            future_dml = commit_task = None
            try:
                await completed_or_blocked(factory, source_task, second_pid, first_pid)
                future_dml = asyncio.create_task(
                    first.execute(
                        update(Source)
                        .where(Source.id == graph.source_id)
                        .values(status="indexed", source_digest=CHANGED_DIGEST)
                    )
                )
                assert await completed_or_blocked(
                    factory, future_dml, first_pid, second_pid
                )
                assert (
                    source_task.done()
                ), "Early metadata maintenance introduced a base-DML lock cycle"
                source_task.result()
                commit_task = asyncio.create_task(finish(second_tx, True))
                await asyncio.wait_for(
                    asyncio.gather(future_dml, commit_task), BARRIER_SECONDS
                )
                await finish(first_tx, True)
            finally:
                await cancel_pending(source_task, future_dml, commit_task)
    final = await committed_snapshot(factory, graph)
    assert_eligible(final, graph, readable=True, inserted=False)


@pytest.mark.parametrize("baseline_only", [True, False], ids=["baseline", "candidate"])
async def test_truncate_and_source_commit_do_not_invert_relation_and_metadata_locks(
    pg, baseline_only
):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    async with bounded_transaction(factory) as (truncator, truncate_tx, truncate_pid):
        async with bounded_transaction(factory) as (writer, write_tx, writer_pid):
            await truncate_owned_chunks(truncator, graph)
            assert_eligible(
                await metadata_snapshot(truncator, graph, baseline_only=baseline_only),
                graph,
                readable=False,
                inserted=False,
            )
            source_task = asyncio.create_task(
                invalidate(writer, graph, "source_pending")
            )
            try:
                # The supported truncator also updates Source counters. The
                # source writer may wait for that row; both still commit.
                await completed_or_blocked(
                    factory, source_task, writer_pid, truncate_pid
                )
                await finish(truncate_tx, True)
                await asyncio.wait_for(asyncio.shield(source_task), BARRIER_SECONDS)
                await finish(write_tx, True)
            finally:
                await cancel_pending(source_task)
    final = await committed_snapshot(factory, graph, baseline_only=baseline_only)
    assert_eligible(final, graph, readable=False, inserted=False)


async def test_baseline_truncate_and_source_commit_preserves_original_schedule(pg):
    graph = await independent_graph(pg)
    factory = pg["factory"]
    async with bounded_transaction(factory) as (truncator, truncate_tx, truncate_pid):
        async with bounded_transaction(factory) as (writer, write_tx, writer_pid):
            await truncate_owned_chunks(truncator, graph, maintain_counters=False)
            await invalidate(writer, graph, "source_pending")
            writer_commit = asyncio.create_task(finish(write_tx, True))
            truncate_commit = None
            try:
                await completed_or_blocked(
                    factory, writer_commit, writer_pid, truncate_pid
                )
                truncate_commit = asyncio.create_task(finish(truncate_tx, True))
                await asyncio.wait_for(
                    asyncio.gather(writer_commit, truncate_commit), BARRIER_SECONDS
                )
            finally:
                await cancel_pending(writer_commit, truncate_commit)
    final = await committed_snapshot(factory, graph, baseline_only=True)
    assert_eligible(final, graph, readable=False, inserted=False)
