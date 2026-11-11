# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Native-PG population transaction cost with fencing and authorization controls."""

import asyncio
import hashlib
import uuid
from contextlib import contextmanager

import pytest
from sqlalchemy import delete, event, func, insert, select, text, update
from sqlalchemy.orm import Session

from app.models.agent_session import AgentSessionContent, AgentSessionEvent
from app.models.session_search import SessionSearchChunk, SessionSearchSource
from app.models.session_search_backfill import (
    SessionSearchBackfillClaim,
    SessionSearchBackfillRun,
)
from app.models.workspace import WorkspaceMember
from app.services import session_search_backfill as backfill
from app.services.session_search_index import SessionSearchObjectProcessor
from tests.rich_capture import declaration
from tests.services.test_session_search_backfill import driver, receipt, run_id
from tests.services.test_session_search_backfill import InterruptedWorker
from tests.test_session_content_postgres import post_batch, session_record
from tests.test_session_search_backfill_postgres import (
    BARRIER_SECONDS,
    actual_waiter,
    backfill_pg as backfill_pg_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
    pg as capture_postgres_fixture,
    session_blocker,
)

pg = capture_postgres_fixture
backfill_pg = backfill_pg_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
BODY = b"round_trip_needle " + b"x" * 1000


async def retained_sources(case, kind, count):
    result = await post_batch(
        case.env,
        [
            session_record(
                case.env,
                "round-trip-" + uuid.uuid4().hex,
                [declaration(BODY, delivery="inline")],
            )
        ],
    )
    assert result["rejected"] == []
    content_id = uuid.UUID(result["contents"][0]["content_id"])
    async with case.factory.begin() as db:
        content = await db.get(AgentSessionContent, content_id)
        session_id = content.session_id
        values = {
            column.name: getattr(content, column.name)
            for column in content.__table__.columns
        }
        await db.execute(
            delete(SessionSearchSource).where(
                SessionSearchSource.content_id == content_id
            )
        )
        identities = [content_id]
        if kind == "inline":
            extras = []
            for ordinal in range(1, count):
                identity = uuid.uuid4()
                identities.append(identity)
                extras.append(
                    {
                        **values,
                        "id": identity,
                        "content_key": hashlib.sha256(identity.bytes).hexdigest(),
                        "source_order": ordinal + 100,
                    }
                )
            if extras:
                await db.execute(insert(AgentSessionContent), extras)
        else:
            await db.execute(
                delete(AgentSessionContent).where(AgentSessionContent.id == content_id)
            )
            identities = [uuid.uuid4() for _ in range(count)]
            await db.execute(
                insert(AgentSessionEvent),
                [
                    {
                        "id": identity,
                        "session_id": session_id,
                        "event_id": identity.hex,
                        "capture_id": values["capture_id"],
                        "occurred_at": values["occurred_at"],
                        "received_at": values["received_at"],
                        "action": "tool.called",
                        "collection_method": "hook",
                        "event": {"tool": {"input": BODY.decode()}},
                    }
                    for identity in identities
                ],
            )
    return {
        "session_id": session_id,
        "content_ids": identities if kind == "inline" else [],
        "identities": identities,
    }


@contextmanager
def transaction_counts(case):
    counts = {
        "begin": 0,
        "commit": 0,
        "rollback": 0,
        "sql": 0,
        "claim_lists": 0,
        "run_updates": 0,
    }
    engine = case.factory.kw["bind"].sync_engine
    listeners = []
    for name in ("begin", "commit", "rollback"):

        def count(_connection, _name=name):
            counts[_name] += 1

        event.listen(engine, name, count)
        listeners.append((name, count))

    def statement(_conn, _cursor, sql, _params, _context, _many):
        counts["sql"] += 1
        if (
            sql.lstrip().startswith("SELECT")
            and "FROM session_search_backfill_claims" in sql
            and "FOR UPDATE" not in sql
        ):
            counts["claim_lists"] += 1
        if sql.lstrip().startswith("UPDATE session_search_backfill_runs"):
            counts["run_updates"] += 1

    event.listen(engine, "after_cursor_execute", statement)
    listeners.append(("after_cursor_execute", statement))
    try:
        yield counts
    finally:
        for name, listener in listeners:
            event.remove(engine, name, listener)


async def settled_index_count(case, source):
    async with case.factory() as db:
        return await db.scalar(
            select(func.count())
            .select_from(SessionSearchSource)
            .where(
                SessionSearchSource.session_id == source["session_id"],
                SessionSearchSource.status == "indexed",
            )
        )


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_source_pass_renews_in_settlement_without_per_source_commit(
    backfill_pg, kind
):
    case = backfill_pg
    source = await retained_sources(case, kind, 26)
    started = await case.start()
    primed = await case.step(started, source_limit=1)
    assert primed["pass"]["sources_attempted"] == 1
    before = await settled_index_count(case, source)
    with transaction_counts(case) as counts:
        result = await case.step(started)
    case.evidence["measured_stored_source_pass"] = {
        "kind": kind,
        "counts": counts,
        "receipt": result,
    }
    assert result["pass"]["sources_attempted"] == 25
    assert result["pass"]["candidate_keys_examined"] <= 200
    assert result["pass"]["reserved_bytes"] <= 64 << 20
    assert result["progress"]["claims"]["outstanding"] == 0
    assert await settled_index_count(case, source) - before == 25
    # Twenty-five independent atomic acknowledgements plus bounded pass control;
    # stored sources must not pay another write transaction merely to renew.
    assert counts["commit"] <= 30, counts


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_source_expiry_during_session_lock_wait_rolls_back_acknowledgement(
    backfill_pg, kind
):
    case = backfill_pg
    source = await retained_sources(case, kind, 1)
    started = await case.start()
    worker = None
    try:
        async with session_blocker(case, source) as (_blocker, blocker_pid):
            worker = asyncio.create_task(case.step(started, source_limit=1))
            waiter = await actual_waiter(case, blocker_pid)
            expired_at = await case.expire_now(started)
            assert waiter["xact_start"] < expired_at
            fenced = await case.snapshot(started, source)
            assert fenced["chunks"] == 0 and len(fenced["claims"]) == 1
        result = await asyncio.wait_for(worker, BARRIER_SECONDS)
        assert result["exit_code"] == 11
        assert await case.snapshot(started, source) == fenced
        assert await settled_index_count(case, source) == 0
    finally:
        if worker and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)


async def test_object_lease_expiry_before_preparation_performs_no_storage_io(
    backfill_pg, monkeypatch
):
    case = backfill_pg
    source = await case.source()
    started = await case.start()
    original = backfill._Pass._renew
    preparations = []

    async def expire_then_renew(worker):
        await case.expire_now(started)
        return await original(worker)

    async def unexpected_prepare(*args, **kwargs):
        preparations.append(True)
        pytest.fail(
            "An expired object worker must fence before external body preparation"
        )

    monkeypatch.setattr(backfill._Pass, "_renew", expire_then_renew)
    monkeypatch.setattr(
        SessionSearchObjectProcessor, "prepare_source", unexpected_prepare
    )
    result = await case.step(started, source_limit=1)
    assert result["exit_code"] == 11
    assert result["pass"]["stat_calls"] == result["pass"]["read_calls"] == 0
    assert preparations == []
    assert len(await case.claims(started)) == 1
    assert await settled_index_count(case, source) == 0


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_source_renewal_preserves_byte_budget(backfill_pg, kind):
    case = backfill_pg
    source = await retained_sources(case, kind, 3)
    started = await case.start()
    result = receipt(
        await driver(case.factory).run_pass(
            run_id(started), source_limit=25, byte_budget=1200
        )
    )
    assert result["reason"] == "byte_budget"
    assert result["pass"]["sources_attempted"] == 1
    assert 0 < result["pass"]["reserved_bytes"] <= 1200
    assert await settled_index_count(case, source) == 1


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_source_revocation_during_session_wait_prevents_indexing(
    backfill_pg, kind
):
    case = backfill_pg
    source = await retained_sources(case, kind, 1)
    started = await case.start()
    worker = None
    try:
        async with session_blocker(case, source) as (_blocker, blocker_pid):
            worker = asyncio.create_task(case.step(started, source_limit=1))
            await actual_waiter(case, blocker_pid)
            async with case.factory.begin() as db:
                await db.execute(
                    delete(WorkspaceMember).where(
                        WorkspaceMember.workspace_id == case.env["workspace_id"],
                        WorkspaceMember.user_id == case.env["owner_id"],
                    )
                )
        result = await asyncio.wait_for(worker, BARRIER_SECONDS)
        assert result["progress"]["outcomes"]["owner_not_member"] == 1
        assert await settled_index_count(case, source) == 0
        async with case.factory() as db:
            assert (
                await db.scalar(
                    select(func.count())
                    .select_from(SessionSearchChunk)
                    .where(SessionSearchChunk.session_id == source["session_id"])
                )
                == 0
            )
    finally:
        if worker and not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_pass_reads_claim_batch_without_polling_after_each_source(
    backfill_pg, kind
):
    case = backfill_pg
    await retained_sources(case, kind, 26)
    started = await case.start()
    await case.step(started, source_limit=1)
    with transaction_counts(case) as counts:
        result = await case.step(started)
    case.evidence["claim_batch_cost"] = {
        "kind": kind,
        "counts": counts,
        "receipt": result,
    }
    assert result["pass"]["sources_attempted"] == 25
    assert result["progress"]["claims"]["outstanding"] == 0
    # Three work-list reads plus scan capacity and the two receipt observations.
    assert counts["claim_lists"] <= 6, counts


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_settlement_updates_lease_and_counters_in_one_write(
    backfill_pg, kind
):
    case = backfill_pg
    await retained_sources(case, kind, 26)
    started = await case.start()
    await case.step(started, source_limit=1)
    with transaction_counts(case) as counts:
        result = await case.step(started)
    case.evidence["coalesced_settlement_cost"] = {
        "kind": kind,
        "counts": counts,
        "receipt": result,
    }
    assert result["pass"]["sources_attempted"] == 25
    assert counts["run_updates"] <= 30, counts


async def test_claim_refill_observes_retry_that_became_due_during_cached_batch(
    backfill_pg, monkeypatch
):
    case = backfill_pg
    source = await retained_sources(case, "inline", 2)
    started = await case.start()
    original_scan = backfill._Pass._scan
    original_index = backfill._Pass._index_stored_source
    deferred = []

    async def schedule_second(worker, *args, **kwargs):
        result = await original_scan(worker, *args, **kwargs)
        rows = await case.claims(started)
        if len(rows) == 2 and not deferred:
            deferred.append(rows[-1]["source_id"])
            async with case.factory.begin() as db:
                await db.execute(
                    update(SessionSearchBackfillClaim)
                    .where(
                        SessionSearchBackfillClaim.run_id == run_id(started),
                        SessionSearchBackfillClaim.source_id == deferred[0],
                    )
                    .values(
                        state="retry_wait",
                        next_attempt_at=func.clock_timestamp()
                        + text("interval '1 hour'"),
                    )
                )
        return result

    async def make_due_after_first(worker, claim):
        result = await original_index(worker, claim)
        if deferred and claim.source_id != deferred[0]:
            async with case.factory.begin() as db:
                await db.execute(
                    update(SessionSearchBackfillClaim)
                    .where(
                        SessionSearchBackfillClaim.run_id == run_id(started),
                        SessionSearchBackfillClaim.source_id == deferred[0],
                    )
                    .values(
                        next_attempt_at=func.clock_timestamp()
                        - text("interval '1 second'")
                    )
                )
        return result

    monkeypatch.setattr(backfill._Pass, "_scan", schedule_second)
    monkeypatch.setattr(backfill._Pass, "_index_stored_source", make_due_after_first)
    result = await case.step(started)
    assert deferred
    assert result["pass"]["sources_attempted"] == 2
    assert await settled_index_count(case, source) == 2
    assert await case.claims(started) == []


async def test_later_cached_source_is_rechecked_after_retention(
    backfill_pg, monkeypatch
):
    case = backfill_pg
    source = await retained_sources(case, "inline", 2)
    started = await case.start()
    original = backfill._Pass._index_stored_source
    removed = []

    async def delete_later_after_first(worker, claim):
        result = await original(worker, claim)
        if not removed:
            later = next(
                identity
                for identity in source["identities"]
                if identity != claim.source_id
            )
            async with case.factory.begin() as db:
                await db.execute(
                    delete(AgentSessionContent).where(AgentSessionContent.id == later)
                )
            removed.append(later)
        return result

    monkeypatch.setattr(
        backfill._Pass, "_index_stored_source", delete_later_after_first
    )
    result = await case.step(started)
    assert removed
    assert result["pass"]["sources_attempted"] == 2
    assert result["progress"]["outcomes"]["indexed"] == 1
    assert result["progress"]["outcomes"]["absent"] == 1
    assert await settled_index_count(case, source) == 1
    assert await case.claims(started) == []


async def test_supersession_fences_remaining_cached_sources(backfill_pg, monkeypatch):
    case = backfill_pg
    source = await retained_sources(case, "inline", 2)
    started = await case.start()
    original = backfill._Pass._index_stored_source
    successor = []

    async def supersede_after_first(worker, claim):
        result = await original(worker, claim)
        if not successor:
            await case.expire_now(started)
            successor.append(await case.start(supersede_run_id=run_id(started)))
        return result

    monkeypatch.setattr(backfill._Pass, "_index_stored_source", supersede_after_first)
    result = await case.step(started)
    assert successor and result["exit_code"] == 11
    assert await settled_index_count(case, source) == 1
    assert await case.claims(started) == []


async def test_stored_settlement_extends_same_lease_atomically_before_pass_release(
    backfill_pg, monkeypatch
):
    case = backfill_pg
    source = await retained_sources(case, "inline", 1)
    started = await case.start()
    original = backfill._Pass._index_stored_source
    observations = []

    async def observe_extension(worker, claim):
        async with case.factory.begin() as db:
            prior = (
                await db.execute(
                    update(SessionSearchBackfillRun)
                    .where(
                        SessionSearchBackfillRun.id == run_id(started),
                    )
                    .values(
                        lease_expires_at=func.clock_timestamp()
                        + text("interval '30 seconds'")
                    )
                    .returning(
                        SessionSearchBackfillRun.lease_epoch,
                        SessionSearchBackfillRun.lease_expires_at,
                    )
                )
            ).one()
        result = await original(worker, claim)
        committed = await case.snapshot(started, source)
        assert committed["run"]["lease_epoch"] == prior.lease_epoch
        assert committed["run"]["lease_expires_at"] > prior.lease_expires_at
        assert committed["run"]["counters"]["indexed"] == 1
        assert committed["claims"] == [] and committed["chunks"] > 0
        observations.append(committed)
        return result

    monkeypatch.setattr(backfill._Pass, "_index_stored_source", observe_extension)
    result = await case.step(started)
    assert observations and result["run"]["lease_expires_at"] is None


@pytest.mark.parametrize("kind", ["inline", "event"])
async def test_stored_settlement_failure_rolls_back_renewal_and_acknowledgement(
    backfill_pg, monkeypatch, kind
):
    case = backfill_pg
    source = await retained_sources(case, kind, 1)
    started = await case.start()
    original = backfill._Pass._index_stored_source
    failures = []

    class SettlementFailure(Exception):
        pass

    async def fail_after_renewal_flush(worker, claim):
        before = await case.snapshot(started, source)

        def reject_flushed_renewal(session, _context):
            for row in session.identity_map.values():
                if (
                    isinstance(row, SessionSearchBackfillRun)
                    and row.id == run_id(started)
                    and row.counters.get("indexed") == 1
                    and row.lease_expires_at > before["run"]["lease_expires_at"]
                ):
                    failures.append(row.lease_expires_at)
                    raise SettlementFailure

        event.listen(Session, "after_flush", reject_flushed_renewal)
        try:
            with pytest.raises(SettlementFailure):
                await original(worker, claim)
        finally:
            event.remove(Session, "after_flush", reject_flushed_renewal)
        # Observe through another connection before failure cleanup or recovery.
        assert failures
        assert await case.snapshot(started, source) == before
        assert await settled_index_count(case, source) == 0
        raise InterruptedWorker

    monkeypatch.setattr(
        backfill._Pass, "_index_stored_source", fail_after_renewal_flush
    )
    with pytest.raises(InterruptedWorker):
        await case.step(started)
