# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01H leases and atomic settlement on an explicitly disposable PostgreSQL.

Root runs this file serially after migration126. Existing capture fixtures own
synthetic source cleanup; this file additionally removes only its run records
and its uniquely named acknowledgement-failure trigger. No SQLite substitute
can qualify these row-lock and database-clock assertions.
"""

import asyncio
import hashlib
import json
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from sqlalchemy import delete, event, func, insert, select, text

from app import database
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.base import Base
from app.models.session_search import (
    SessionSearchChunk,
    SessionSearchSource,
    SessionSearchState,
)
from app.models.workspace import WorkspaceMember
from app.services.session_search_index import SessionSearchObjectProcessor
from tests.rich_capture import declaration, upload
from tests.services.test_session_search_backfill import driver, receipt, run_id
from tests.test_session_content_postgres import (
    pg as capture_postgres_fixture,
    post_batch,
    session_record,
)
from tests.test_session_search import (
    exact_match,
    paused_object_indexing as paused_object_indexing_fixture,
    search,
)

pg = capture_postgres_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
BARRIER_SECONDS = 5
BODY = ("PostgreSQL retained Straße_LEASE_CONTROL " + "." * 24_000).encode()
QUERY = "strasse_lease_control"


def tables():
    return (
        Base.metadata.tables["session_search_backfill_runs"],
        Base.metadata.tables["session_search_backfill_claims"],
    )


class BackfillPG:
    def __init__(self, env):
        self.env = env
        self.factory = env["factory"]
        self.owned_runs = set()
        self.evidence = {"observations": [], "receipts": []}

    async def start(self, **options):
        value = receipt(await driver(self.factory).start_run(scope="all_workspaces", **options))
        self.owned_runs.add(run_id(value))
        self.evidence["receipts"].append(value)
        return value

    async def step(self, started, *, source_limit=25):
        value = receipt(await driver(self.factory).run_pass(
            run_id(started), source_limit=source_limit, byte_budget=67_108_864
        ))
        self.evidence["receipts"].append(value)
        return value

    async def source(self, *, copies=1):
        result = await post_batch(self.env, [session_record(
            self.env, "backfill-pg-" + uuid.uuid4().hex,
            [declaration(BODY, delivery="upload")],
        )])
        assert result["rejected"] == []
        [ack] = result["contents"]
        assert ack["outcome"] == "upload_required"
        assert (await upload(self.env["client"], self.env, ack, BODY))["state"] == "available"
        content_id = uuid.UUID(ack["content_id"])
        async with self.factory.begin() as db:
            content = await db.get(AgentSessionContent, content_id)
            values = {
                column.name: getattr(content, column.name)
                for column in AgentSessionContent.__table__.columns
            }
            source = {
                "session_id": content.session_id,
                "content_id": content_id,
                "content_ids": [content_id],
                "path": f"/api/workspaces/{self.env['slug']}/sessions/{content.session_id}",
            }
            # The committed object exists; remove only its derived pending
            # record to model an old writer that predates the index.
            await db.execute(delete(SessionSearchSource).where(
                SessionSearchSource.content_id == content_id
            ))
            for ordinal in range(1, copies):
                extra_id = uuid.uuid4()
                db.add(AgentSessionContent(**{
                    **values,
                    "id": extra_id,
                    "content_key": hashlib.sha256(extra_id.bytes).hexdigest(),
                    "source_order": values["source_order"] + ordinal,
                }))
                source["content_ids"].append(extra_id)
        positive = await self.env["client"].get(f"{source['path']}/contents/{content_id}/body")
        assert positive.status_code == 200
        assert positive.json()["text"].encode() == BODY
        before = await search(self.env["client"], source["path"], QUERY)
        assert before["items"] == []
        assert before["coverage"]["pending_index"]["count"] == copies
        return source

    async def claims(self, started):
        _, claims_table = tables()
        async with self.factory.begin() as db:
            return [dict(row) for row in (await db.execute(
                select(claims_table).where(claims_table.c.run_id == run_id(started))
                .order_by(claims_table.c.source_kind, claims_table.c.source_id)
            )).mappings()]

    async def snapshot(self, started, source, *, db=None):
        if db is None:
            async with self.factory.begin() as independent:
                return await self.snapshot(started, source, db=independent)
        runs, claims_table = tables()
        row = (await db.execute(select(runs).where(runs.c.id == run_id(started)))).mappings().one()
        claims = (await db.execute(
            select(claims_table).where(claims_table.c.run_id == run_id(started))
            .order_by(claims_table.c.source_kind, claims_table.c.source_id)
        )).mappings().all()
        sources = (await db.execute(select(
            SessionSearchSource.id, SessionSearchSource.content_id,
            SessionSearchSource.status, SessionSearchSource.source_digest,
            SessionSearchSource.chunk_count,
        ).where(SessionSearchSource.content_id.in_(source["content_ids"]))
            .order_by(SessionSearchSource.content_id))).all()
        chunks = await db.scalar(select(func.count()).select_from(SessionSearchChunk).where(
            SessionSearchChunk.session_id == source["session_id"]
        ))
        generation = await db.scalar(select(SessionSearchState.generation).where(
            SessionSearchState.session_id == source["session_id"]
        ))
        return {
            "run": dict(row), "claims": [dict(item) for item in claims],
            "sources": [tuple(item) for item in sources],
            "chunks": chunks, "generation": generation,
        }

    async def expire_now(self, started):
        # clock_timestamp is wall time; transaction_timestamp/now can remain
        # before expiry while a settlement transaction waits on a row lock.
        async def expire():
            async with self.factory.begin() as db:
                expired_at = await db.scalar(text(
                    "UPDATE session_search_backfill_runs "
                    "SET lease_expires_at = clock_timestamp() WHERE id = :run_id "
                    "RETURNING lease_expires_at"
                ), {"run_id": run_id(started)})
                observed_at = await db.scalar(text("SELECT clock_timestamp()"))
                assert expired_at <= observed_at
                self.evidence["observations"].append({
                    "kind": "database_clock_expiry",
                    "expired_at": expired_at.isoformat(), "observed_at": observed_at.isoformat(),
                })
                return expired_at
        # Incorrect run-before-session locking must fail, not hang this fixture.
        return await asyncio.wait_for(expire(), BARRIER_SECONDS)


@pytest.fixture
async def backfill_pg(pg, monkeypatch, tmp_path, request):
    assert pg["factory"].kw["bind"].dialect.name == "postgresql"
    monkeypatch.setattr(database, "async_session", pg["factory"])
    case = BackfillPG(pg)
    async with case.factory.begin() as db:
        assert int(await db.scalar(text("SELECT version_num FROM alembic_version"))) >= 126
    try:
        yield case
    finally:
        try:
            if case.owned_runs:
                runs, _ = tables()
                async with case.factory.begin() as db:
                    await db.execute(delete(runs).where(runs.c.id.in_(case.owned_runs)))
        finally:
            case.evidence["test"] = request.node.name
            case.evidence["test_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            (tmp_path / "backfill-postgres-receipt.json").write_text(
                json.dumps(case.evidence, indent=2, default=str) + "\n"
            )


async def attempt_source(case, started, *, source_limit=25):
    for _ in range(4):
        value = await case.step(started, source_limit=source_limit)
        if value["pass"]["sources_attempted"] or value["exit_code"] not in {0, 10}:
            return value
    pytest.fail("Four external passes did not attempt the retained source")


@asynccontextmanager
async def held_preparation(case, started, source, monkeypatch, *, source_limit=25):
    entered, released = asyncio.Event(), asyncio.Event()
    original = SessionSearchObjectProcessor.prepare_source
    observed = {"preparations": 0}

    async def prepare_then_hold(processor, content_id, **options):
        prepared = await original(processor, content_id, **options)
        if content_id in source["content_ids"]:
            observed["preparations"] += 1
            if not entered.is_set():
                assert prepared.outcome == "ready"
                committed = await case.claims(started)
                assert any(row["source_id"] == content_id for row in committed)
                observed["committed_claims_at_prepare"] = len(committed)
                observed["prepared_content_id"] = content_id
                entered.set()
                await released.wait()
        return prepared

    with monkeypatch.context() as patch:
        patch.setattr(SessionSearchObjectProcessor, "prepare_source", prepare_then_hold)
        task = asyncio.create_task(attempt_source(case, started, source_limit=source_limit))
        arrival = asyncio.create_task(entered.wait())
        try:
            await asyncio.wait({task, arrival}, timeout=BARRIER_SECONDS, return_when=asyncio.FIRST_COMPLETED)
            if not entered.is_set():
                if task.done():
                    task.result()
                pytest.fail("Worker did not reach committed-claim/actual-object preparation")
            yield task, released, observed
        finally:
            released.set()
            arrival.cancel()
            await asyncio.gather(arrival, return_exceptions=True)
            if not task.done():
                try:
                    await asyncio.wait_for(asyncio.shield(task), BARRIER_SECONDS)
                except BaseException:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                    raise


async def actual_waiter(case, blocker_pid):
    # Observe an actual server-side lock wait. Repeated independent statements
    # yield on I/O; there is no sleep, SQL mock or assumed scheduling delay.
    async def observe():
        while True:
            async with case.factory.begin() as db:
                rows = (await db.execute(text(
                    "SELECT pid, xact_start, wait_event_type, clock_timestamp() AS observed_at "
                    "FROM pg_stat_activity WHERE datname = current_database() "
                    "AND :blocker = ANY(pg_blocking_pids(pid))"
                ), {"blocker": blocker_pid})).mappings().all()
            if rows:
                assert len(rows) == 1, rows
                row = dict(rows[0])
                # Activity statistics and pg_blocking_pids are sampled separately.
                # Wait for both lock signals within the original barrier deadline.
                if row["wait_event_type"] != "Lock":
                    case.evidence["observations"].append({"kind": "lock_wait_transition", **row})
                    continue
                assert row["wait_event_type"] == "Lock"
                assert row["pid"] != blocker_pid
                case.evidence["observations"].append({"kind": "actual_lock_wait", **row})
                return row
    return await asyncio.wait_for(observe(), BARRIER_SECONDS)


@asynccontextmanager
async def session_blocker(case, source):
    async with case.factory() as db:
        transaction = await db.begin()
        try:
            pid = await db.scalar(text("SELECT pg_backend_pid()"))
            assert await db.scalar(select(AgentSession.id).where(
                AgentSession.id == source["session_id"]
            ).with_for_update()) == source["session_id"]
            yield db, pid
        finally:
            if transaction.is_active:
                await transaction.commit()


async def assert_indexed(case, source):
    page = await search(case.env["client"], source["path"], QUERY)
    [item] = page["items"]
    assert item["content_id"] == str(source["content_id"])
    exact_match(item, BODY.decode(), "Straße_LEASE_CONTROL")
    return page


async def test_postgres_concurrent_same_identity_start_creates_one_active_run(backfill_pg):
    case = backfill_pg
    await case.source()
    gate = asyncio.Event()

    async def start_together():
        await gate.wait()
        return await case.start()

    first, second = asyncio.create_task(start_together()), asyncio.create_task(start_together())
    gate.set()
    try:
        values = await asyncio.wait_for(asyncio.gather(first, second), BARRIER_SECONDS)
    finally:
        for task in (first, second):
            if not task.done():
                task.cancel()
        await asyncio.gather(first, second, return_exceptions=True)
    assert values[0]["run"]["id"] == values[1]["run"]["id"]
    assert sorted(value["result"] for value in values) == ["created", "existing"]
    runs, _ = tables()
    async with case.factory.begin() as db:
        active = (await db.execute(select(runs.c.id).where(
            runs.c.lane == "retained_session_search", runs.c.finished_at.is_(None)
        ))).scalars().all()
    assert active == [run_id(values[0])]


async def test_postgres_competing_pass_cannot_share_live_lease(backfill_pg, monkeypatch):
    case = backfill_pg
    source = await case.source()
    started = await case.start()
    async with held_preparation(case, started, source, monkeypatch) as (worker, release, observed):
        before = await case.snapshot(started, source)
        second = await asyncio.wait_for(case.step(started), BARRIER_SECONDS)
        assert second["exit_code"] == 11
        assert observed["preparations"] == 1
        assert await case.snapshot(started, source) == before
        release.set()
        first = await asyncio.wait_for(worker, BARRIER_SECONDS)
    assert first["pass"]["sources_attempted"] == 1
    await assert_indexed(case, source)


async def test_postgres_recovered_worker_fences_late_prepared_settlement_atomically(backfill_pg, monkeypatch):
    case = backfill_pg
    source = await case.source()
    started = await case.start()
    async with held_preparation(case, started, source, monkeypatch) as (old_worker, release, observed):
        before = await case.snapshot(started, source)
        await case.expire_now(started)
        recovered = await asyncio.wait_for(attempt_source(case, started), BARRIER_SECONDS)
        assert recovered["exit_code"] in {0, 10}
        after_recovery = await case.snapshot(started, source)
        assert after_recovery["run"]["lease_epoch"] > before["run"]["lease_epoch"]
        assert after_recovery["chunks"] > 0
        assert after_recovery["generation"] > (before["generation"] or 0)
        assert after_recovery["claims"] == []
        assert observed["preparations"] == 2
        release.set()
        stale = await asyncio.wait_for(old_worker, BARRIER_SECONDS)
    assert stale["exit_code"] == 11
    assert await case.snapshot(started, source) == after_recovery
    await assert_indexed(case, source)


async def test_postgres_expiry_during_real_lock_wait_rolls_back_without_successor(backfill_pg, monkeypatch):
    case = backfill_pg
    source = await case.source()
    started = await case.start()
    async with held_preparation(case, started, source, monkeypatch) as (worker, release, _):
        async with session_blocker(case, source) as (_blocker, blocker_pid):
            release.set()
            waiter = await actual_waiter(case, blocker_pid)
            expired_at = await case.expire_now(started)
            assert waiter["xact_start"] < expired_at
            fenced = await case.snapshot(started, source)
            assert fenced["chunks"] == 0
            assert len(fenced["claims"]) == 1
        result = await asyncio.wait_for(worker, BARRIER_SECONDS)
    assert result["exit_code"] == 11
    assert await case.snapshot(started, source) == fenced
    assert (await search(case.env["client"], source["path"], QUERY))["items"] == []


@asynccontextmanager
async def reject_acknowledgement_after_index(case, started, source, generation_before):
    name = "b01h_ack_" + uuid.uuid4().hex
    observed = []
    engine = case.factory.kw["bind"].sync_engine

    def observe_database_error(context):
        match = re.search(
            r"B01H_ACK_(FAILURE_AFTER_INDEX|INDEX_PRECONDITION_MISSING):(\d+)",
            str(context.original_exception),
        )
        if match:
            observed.append({"marker": match[1], "backend_pid": int(match[2])})

    # All interpolated identifiers/values are locally generated UUIDs or an
    # integer read from this fixture. The trigger is restricted to this run.
    create = f"""
        CREATE FUNCTION {name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF OLD.run_id = '{run_id(started)}'::uuid THEN
            IF NOT EXISTS (
              SELECT 1 FROM session_search_sources s
              JOIN session_search_chunks c ON c.source_id = s.id
              JOIN session_search_states g ON g.session_id = s.session_id
              WHERE s.content_id = '{source['content_id']}'::uuid
                AND s.session_id = '{source['session_id']}'::uuid
                AND s.source_digest = '{hashlib.sha256(BODY).hexdigest()}'
                AND s.status = 'indexed' AND s.chunk_count > 0
                AND g.generation > {generation_before or 0}
            ) THEN
              RAISE EXCEPTION 'B01H_ACK_INDEX_PRECONDITION_MISSING:%', pg_backend_pid();
            END IF;
            RAISE EXCEPTION 'B01H_ACK_FAILURE_AFTER_INDEX:%', pg_backend_pid();
          END IF;
          RETURN OLD;
        END;
        $$
    """
    async with case.factory.begin() as db:
        await db.execute(text(create))
        await db.execute(text(
            f"CREATE TRIGGER {name} BEFORE DELETE ON session_search_backfill_claims "
            f"FOR EACH ROW EXECUTE FUNCTION {name}()"
        ))
    event.listen(engine, "handle_error", observe_database_error)
    try:
        yield observed
    finally:
        event.remove(engine, "handle_error", observe_database_error)
        async with case.factory.begin() as db:
            await db.execute(text(f"DROP TRIGGER {name} ON session_search_backfill_claims"))
            await db.execute(text(f"DROP FUNCTION {name}()"))


async def test_postgres_claim_ack_failure_rolls_back_index_generation_and_progress(backfill_pg, monkeypatch):
    case = backfill_pg
    source = await case.source()
    started = await case.start()
    async with held_preparation(case, started, source, monkeypatch) as (worker, release, _):
        before = await case.snapshot(started, source)
        assert before["chunks"] == 0 and len(before["claims"]) == 1
        async with reject_acknowledgement_after_index(case, started, source, before["generation"]) as observed:
            async with case.factory.begin() as inspector:
                # Keep this physical connection checked out across settlement,
                # so the rollback observation cannot reuse the worker's PID.
                inspector_pid = await inspector.scalar(text("SELECT pg_backend_pid()"))
                release.set()
                error = None
                try:
                    result = await asyncio.wait_for(worker, BARRIER_SECONDS)
                except Exception as failure:
                    error = failure
                if error is None:
                    assert result["exit_code"] == 1
                else:
                    assert not isinstance(error, TimeoutError)
                # Inspect only fixed test markers at the actual DB error seam;
                # production logs and receipts remain free to redact errors.
                assert observed and {item["marker"] for item in observed} == {"FAILURE_AFTER_INDEX"}
                assert all(item["backend_pid"] != inspector_pid for item in observed)
                after = await case.snapshot(started, source, db=inspector)
                assert (after["sources"], after["chunks"], after["generation"]) == (
                    before["sources"], before["chunks"], before["generation"]
                )
                assert after["claims"] == before["claims"]
                assert after["run"]["counters"] == before["run"]["counters"]
                case.evidence["observations"].append({
                    "kind": "ack_failure_atomic_rollback", "database_errors": observed,
                    "inspector_pid": inspector_pid,
                    "before_generation": before["generation"], "after_generation": after["generation"],
                    "before_chunks": before["chunks"], "after_chunks": after["chunks"],
                    "claim_count": len(after["claims"]),
                })
    await case.expire_now(started)
    successful = await attempt_source(case, started)
    assert successful["exit_code"] in {0, 10}
    await assert_indexed(case, source)


async def test_postgres_supersession_refuses_live_lease_then_fences_before_25_claim_cleanup(backfill_pg, monkeypatch):
    case = backfill_pg
    source = await case.source(copies=25)
    started = await case.start()
    runs, claims_table = tables()
    async with held_preparation(case, started, source, monkeypatch) as (old_worker, release, observed):
        committed = await case.claims(started)
        assert 1 <= len(committed) <= 25
        actual = next(row for row in committed if row["source_id"] == observed["prepared_content_id"])
        claimed = {row["source_id"] for row in committed}
        seeded = [{
            **actual, "source_id": identity, "state": "pending", "attempts": 0,
            "next_attempt_at": None, "reason": None,
        } for identity in source["content_ids"] if identity not in claimed]
        if seeded:
            # These rows exercise only bounded cleanup bookkeeping. The copied
            # fingerprint does not claim each descriptor was independently
            # verified; the first real claim remains the settlement/race seam.
            async with case.factory.begin() as db:
                await db.execute(insert(claims_table), seeded)
        assert len(await case.claims(started)) == 25
        case.evidence["observations"].append({
            "kind": "supersession_cleanup_fixture", "real_claims": len(committed),
            "seeded_bookkeeping_claims": len(seeded), "total_claims": 25,
        })
        live = await asyncio.wait_for(case.start(
            new_verification_epoch=True, supersede_run_id=run_id(started)
        ), BARRIER_SECONDS)
        assert live["exit_code"] == 11
        assert len(await case.claims(started)) == 25
        await case.expire_now(started)
        cleanup = None
        async with case.factory() as blocker:
            transaction = await blocker.begin()
            try:
                blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
                await blocker.execute(select(claims_table).where(
                    claims_table.c.run_id == run_id(started)
                ).with_for_update())
                cleanup = asyncio.create_task(case.start(
                    new_verification_epoch=True, supersede_run_id=run_id(started)
                ))
                await actual_waiter(case, blocker_pid)
                async with case.factory.begin() as inspector:
                    # NOWAIT proves cleanup does not retain the run lock while
                    # waiting for a settlement-held claim row.
                    predecessor = (await inspector.execute(select(runs).where(
                        runs.c.id == run_id(started)
                    ).with_for_update(nowait=True))).mappings().one()
                    assert predecessor["phase"] == "superseded"
                    assert predecessor["finished_at"] is not None
                    assert predecessor["superseded_by"] is not None
                    case.owned_runs.add(predecessor["superseded_by"])
                    active = (await inspector.execute(select(runs.c.id).where(
                        runs.c.lane == "retained_session_search", runs.c.finished_at.is_(None)
                    ))).scalars().all()
                    assert active == [predecessor["superseded_by"]]
            finally:
                await transaction.rollback()
                if cleanup is not None and not cleanup.done():
                    try:
                        await asyncio.wait_for(asyncio.shield(cleanup), BARRIER_SECONDS)
                    except BaseException:
                        cleanup.cancel()
                        await asyncio.gather(cleanup, return_exceptions=True)
                        raise
        successor = cleanup.result()
        assert successor["exit_code"] == 0
        assert run_id(successor) != run_id(started)
        assert await case.claims(started) == []
        release.set()
        stale = await asyncio.wait_for(old_worker, BARRIER_SECONDS)
    assert stale["exit_code"] == 11
    after = await case.snapshot(started, source)
    assert after["sources"] == [] and after["chunks"] == 0
    assert sum(after["run"]["counters"].get(key, 0) for key in ("indexed", "unchanged")) == 0


@pytest.mark.parametrize("change", ["delete", "revoke"])
async def test_postgres_source_loss_while_settlement_waits_prevents_index(backfill_pg, monkeypatch, change):
    case = backfill_pg
    source = await case.source()
    started = await case.start()
    async with held_preparation(case, started, source, monkeypatch) as (worker, release, _):
        async with session_blocker(case, source) as (blocker, blocker_pid):
            release.set()
            await actual_waiter(case, blocker_pid)
            if change == "delete":
                await blocker.execute(delete(AgentSession).where(AgentSession.id == source["session_id"]))
            else:
                await blocker.execute(delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == case.env["workspace_id"],
                    WorkspaceMember.user_id == case.env["owner_id"],
                ))
        result = await asyncio.wait_for(worker, BARRIER_SECONDS)
    assert result["exit_code"] in {0, 10}
    after = await case.snapshot(started, source)
    assert after["sources"] == [] and after["chunks"] == 0
    assert after["claims"] == []
    denied = await case.env["client"].post(f"{source['path']}/search", json={"q": QUERY})
    assert denied.status_code == (404 if change == "delete" else 403)
    assert "Straße_LEASE_CONTROL" not in denied.text
