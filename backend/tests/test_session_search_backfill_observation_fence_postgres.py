# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""An unfinished fenced pass cannot publish its pre-finish scope observation.

The sweep, aggregate, run-row lock and PostgreSQL wall clock are real. The only
worker wrapper suspends entry to its original finish method, without replacing
any decision, scope, result or transaction. Root executes this opt-in PG leg.
"""

import asyncio
import hashlib
import json
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
from sqlalchemy import event, func, select, text
from sqlalchemy.engine import make_url

from app.models.agent_session import AgentSession
from app.models.session_search_backfill import SessionSearchBackfillRun
from app.services import session_search_backfill as backfill
from tests.services.test_session_search_backfill import driver, receipt, run_id
from tests.test_session_content_postgres import database_url
from tests.test_session_search_backfill_postgres import (
    BARRIER_SECONDS,
    BODY,
    actual_waiter,
    assert_indexed,
    backfill_pg as backfill_pg_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
    pg as capture_postgres_fixture,
    tables,
)

pg = capture_postgres_fixture
backfill_pg = backfill_pg_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]
DATABASE_NAME = "session_search_backfill_b01h_20261019"


@pytest.fixture(autouse=True)
def exact_disposable_database():
    # Validate before the imported PG fixture connects; missing opt-in follows
    # its established skip/required-leg behavior, never a default database.
    url = make_url(database_url())
    assert url.drivername == "postgresql+asyncpg"
    assert url.host == "127.0.0.1" and url.port == 55446
    assert url.database == DATABASE_NAME and url.username == "b03_test"
    return url


def input_hashes():
    backend = Path(__file__).resolve().parents[1]
    paths = (
        "app/services/session_search_backfill.py",
        "app/repositories/session_search_backfill.py",
        "app/schemas/session_search_backfill.py",
        "tests/test_session_search_backfill_postgres.py",
        "tests/test_session_content_postgres.py",
        "tests/test_session_search_backfill_observation_fence_postgres.py",
    )
    return {
        path: hashlib.sha256((backend / path).read_bytes()).hexdigest()
        for path in paths
    }


@pytest.fixture
async def fence_case(backfill_pg, exact_disposable_database, tmp_path):
    case = backfill_pg
    before = input_hashes()
    async with case.factory() as db:
        identity = (
            (
                await db.execute(
                    text(
                        "SELECT current_database() AS database_name, current_user AS role_name, "
                        "inet_server_port() AS server_port, version() AS server_version"
                    )
                )
            )
            .mappings()
            .one()
        )
        assert identity["database_name"] == exact_disposable_database.database
        assert identity["role_name"] == "b03_test" and identity["server_port"] == 55446
        assert await db.scalar(text("SELECT version_num FROM alembic_version")) == "130"
        # The all-workspaces aggregate needs a known corpus. Fail on unrelated
        # rows rather than cleaning other actors' work to manufacture a result.
        assert await db.scalar(select(func.count()).select_from(AgentSession)) == 0
        assert (
            await db.scalar(select(func.count()).select_from(SessionSearchBackfillRun))
            == 0
        )
    observations = {
        "database_identity": dict(identity),
        "input_hashes_before": before,
        "aggregate_queries": [],
        "phase": "source setup",
    }
    case.evidence["observation_fence"] = observations
    engine = case.factory.kw["bind"].sync_engine

    def aggregate_completed(
        _connection, _cursor, statement, _parameters, _context, _many
    ):
        if (
            "'excluded_content'" in statement
            and "'unresolved_metadata'" in statement
            and "UNION ALL" in statement.upper()
        ):
            observations["aggregate_queries"].append(
                {
                    "phase": observations["phase"],
                    "statement": statement,
                }
            )

    event.listen(engine, "after_cursor_execute", aggregate_completed)
    try:
        yield case, observations
    finally:
        event.remove(engine, "after_cursor_execute", aggregate_completed)
        after = input_hashes()
        observations["input_hashes_after"] = after
        (tmp_path / "backfill-observation-fence-receipt.json").write_text(
            json.dumps(case.evidence, indent=2, default=str) + "\n"
        )
        assert after == before


@asynccontextmanager
async def pause_before_finish(case, started, monkeypatch):
    entered, released = asyncio.Event(), asyncio.Event()
    original_finish = backfill._Pass._finish
    gate = {}

    async def finish_after_release(worker, reason):
        if worker.run_id == run_id(started) and not gate:
            gate.update(epoch=worker.epoch, reason=reason)
            entered.set()
            await released.wait()
        return await original_finish(worker, reason)

    with monkeypatch.context() as patch:
        patch.setattr(backfill._Pass, "_finish", finish_after_release)
        task = asyncio.create_task(case.step(started))
        arrival = asyncio.create_task(entered.wait())
        try:
            await asyncio.wait(
                {task, arrival},
                timeout=BARRIER_SECONDS,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not entered.is_set():
                if task.done():
                    task.result()
                pytest.fail("Real backfill did not reach its finish boundary")
            yield task, released, gate
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


async def test_unfinished_lease_lost_after_final_scope_has_no_observation(
    fence_case,
    monkeypatch,
):
    case, evidence = fence_case
    source = await case.source()
    evidence["phase"] = "start"
    started = await case.start()
    assert started["coverage"]["pending_index"] == {"count": 1, "bytes": len(BODY)}
    assert started["readiness"] == "in_progress"
    assert any(row["phase"] == "start" for row in evidence["aggregate_queries"])
    runs, _ = tables()

    evidence["phase"] = "worker sweep"
    async with pause_before_finish(case, started, monkeypatch) as (
        worker,
        release,
        gate,
    ):
        assert gate["reason"] == "clean_observation"
        before_fence = await case.snapshot(started, source)
        assert before_fence["run"]["finished_at"] is None
        assert before_fence["run"]["lease_epoch"] == gate["epoch"]
        assert before_fence["run"]["counters"]["indexed"] == 1
        assert before_fence["claims"] == [] and before_fence["chunks"] > 0
        assert before_fence["generation"] > 0
        assert any(
            row["phase"] == "worker sweep" for row in evidence["aggregate_queries"]
        )
        await assert_indexed(case, source)

        async with case.factory() as blocker, blocker.begin():
            blocker_pid = await blocker.scalar(text("SELECT pg_backend_pid()"))
            locked = await blocker.scalar(
                select(runs.c.id).where(runs.c.id == run_id(started)).with_for_update()
            )
            assert locked == run_id(started)
            release.set()
            waiter = await actual_waiter(case, blocker_pid)
            expired_at = await blocker.scalar(
                text(
                    "UPDATE session_search_backfill_runs "
                    "SET lease_expires_at = clock_timestamp() WHERE id = :run_id "
                    "RETURNING lease_expires_at"
                ),
                {"run_id": run_id(started)},
            )
            observed_at = await blocker.scalar(text("SELECT clock_timestamp()"))
            assert waiter["xact_start"] < expired_at <= observed_at
            fenced = await case.snapshot(started, source, db=blocker)
            assert {
                key: value
                for key, value in fenced["run"].items()
                if key != "lease_expires_at"
            } == {
                key: value
                for key, value in before_fence["run"].items()
                if key != "lease_expires_at"
            }
            assert fenced["claims"] == before_fence["claims"]
            evidence["expiry"] = {
                "blocker_pid": blocker_pid,
                "waiter_pid": waiter["pid"],
                "waiter_transaction_started": waiter["xact_start"],
                "database_expired_at": expired_at,
                "database_observed_at": observed_at,
                "epoch": gate["epoch"],
            }
        # Releasing the actual row lock lets the original _finish re-read the
        # live database clock. No ten-minute sleep or mocked time/fence result.
        stale = await asyncio.wait_for(worker, BARRIER_SECONDS)

    assert stale["result"] == "busy" and stale["exit_code"] == 11
    assert stale["reason"] == stale["pass"]["stop_reason"] == "lease_lost"
    assert stale["run"]["finished_at"] is None and stale["run"]["finish_reason"] is None
    assert stale["run"]["lease_epoch"] == gate["epoch"]
    assert stale["pass"]["sources_attempted"] == 1
    assert stale["pass"]["requested_bytes"] == len(BODY) + 1
    assert stale["progress"]["outcomes"]["indexed"] == 1
    assert stale["progress"]["claims"]["outstanding"] == 0
    assert await case.snapshot(started, source) == fenced
    evidence["fenced_state_unchanged"] = True

    # These controls run before the final causal assertion, so the first red
    # records current status and real recovery before the receipt assertion.
    evidence["phase"] = "unfinished status"
    current = receipt(await driver(case.factory).status(run_id(started)))
    case.evidence["receipts"].append(current)
    assert any(
        row["phase"] == "unfinished status" for row in evidence["aggregate_queries"]
    )
    assert current["coverage"]["indexed"] == {"count": 1, "bytes": len(BODY)}
    assert current["coverage"]["index_ready"] is True
    assert current["readiness"] == "in_progress" and current["exit_code"] == 10
    assert current["progress"] == stale["progress"]
    assert await case.snapshot(started, source) == fenced

    evidence["phase"] = "recovery finish"
    recovered = await case.step(started)
    assert (
        recovered["reason"] == recovered["pass"]["stop_reason"] == "clean_observation"
    )
    assert recovered["result"] == "finished" and recovered["exit_code"] == 0
    assert recovered["readiness"] == "ready_at_observation"
    assert recovered["run"]["lease_epoch"] == gate["epoch"] + 1
    assert recovered["run"]["finished_at"] is not None
    assert recovered["run"]["lease_expires_at"] is None
    assert (
        recovered["pass"]["sources_attempted"] == recovered["pass"]["read_calls"] == 0
    )
    assert recovered["progress"] == current["progress"]
    assert any(
        row["phase"] == "recovery finish" for row in evidence["aggregate_queries"]
    )
    finished = await case.snapshot(started, source)
    for name in ("claims", "sources", "chunks", "generation"):
        assert finished[name] == fenced[name]
    assert finished["run"]["counters"] == fenced["run"]["counters"]

    evidence["phase"] = "already finished pass"
    terminal = await case.step(started)
    assert (
        terminal["readiness"] == "ready_at_observation" and terminal["exit_code"] == 0
    )
    assert terminal["coverage"]["indexed"] == {"count": 1, "bytes": len(BODY)}
    assert terminal["pass"]["sources_attempted"] == terminal["pass"]["read_calls"] == 0
    assert any(
        row["phase"] == "already finished pass" for row in evidence["aggregate_queries"]
    )
    assert await case.snapshot(started, source) == finished
    await assert_indexed(case, source)
    evidence["controls_complete"] = True

    # This receipt was produced while the durable run was unfinished. A real
    # aggregate computed before a failed finish cannot become its observation.
    assert {"coverage": stale["coverage"], "readiness": stale["readiness"]} == {
        "coverage": None,
        "readiness": None,
    }
