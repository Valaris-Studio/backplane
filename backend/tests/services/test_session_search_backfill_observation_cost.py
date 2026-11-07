# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Whole-corpus observation belongs at explicit and terminal boundaries.

The service, aggregate and SQLite queries are real. SQL capture records executed
statements without parameters; it never replaces coverage with a test answer.
File-backed SQLite proves committed scheduling here, not PostgreSQL lock waits.
"""

import hashlib
import json
import uuid
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, event, select, update

from app.config import settings
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.models.session_search_backfill import (
    SessionSearchBackfillClaim,
    SessionSearchBackfillRun,
)
from app.models.workspace import WorkspaceMember
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.services import session_search_backfill as backfill
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.storage.session_content import LocalContentStore
from tests.services.test_session_search_backfill import (
    capture as capture_fixture,
    claims,
    db_engine as physical_db_engine,
    driver,
    indexed_count,
    paused_object_indexing as paused_object_indexing_fixture,
    receipt,
    retained as retained_fixture,
    run_id,
)
from tests.services.test_session_search_backfill_review import external_producer_interval
from tests.test_session_search import exact_match

capture = capture_fixture
paused_object_indexing = paused_object_indexing_fixture
db_engine = physical_db_engine
retained = retained_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


@pytest.fixture
async def observation_case(retained, db_engine, tmp_path, request):
    backend = Path(__file__).resolve().parents[2]
    retained.evidence["observation_cost"] = {
        "test": request.node.name,
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_sha256": {
            path: hashlib.sha256((backend / path).read_bytes()).hexdigest()
            for path in (
                "app/services/session_search_backfill.py",
                "app/repositories/session_search_backfill.py",
                "app/schemas/session_search_backfill.py",
                "app/services/session_search_index.py",
            )
        },
        "captures": [],
    }
    try:
        yield retained, db_engine
    finally:
        (tmp_path / "backfill-observation-cost-receipt.json").write_text(
            json.dumps(retained.evidence, indent=2) + "\n"
        )


@contextmanager
def capture_sql(case, engine, label):
    capture = {"label": label, "actor": "observer", "statements": []}
    case.evidence["observation_cost"]["captures"].append(capture)

    def observed(_connection, cursor, statement, _parameters, _context, _many):
        capture["statements"].append({
            "actor": capture["actor"],
            "sql": statement,
            "columns": [column[0] for column in (cursor.description or ())],
        })

    event.listen(engine.sync_engine, "after_cursor_execute", observed)
    try:
        yield capture
    finally:
        event.remove(engine.sync_engine, "after_cursor_execute", observed)


def aggregate_statements(capture, actor="observer"):
    # These literal UNION branches identify the actual scope-wide query. Start
    # and status controls require it to be captured, so an inert detector fails.
    return [row for row in capture["statements"] if row["actor"] == actor
            and "'excluded_content'" in row["sql"]
            and "'unresolved_metadata'" in row["sql"]
            and "UNION ALL" in row["sql"].upper()]


def assert_fresh_observation(value, capture):
    assert aggregate_statements(capture), capture
    coverage = value["coverage"]
    assert coverage is not None
    assert coverage["observed_from"] <= coverage["observed_at"]
    assert value["readiness"] is not None


def assert_unobserved_pass(value, capture, *, reason, exit_code):
    assert value["reason"] == value["pass"]["stop_reason"] == reason
    assert value["exit_code"] == exit_code
    assert value["run"]["finished_at"] is None
    assert {
        "aggregate_queries": len(aggregate_statements(capture)),
        "coverage": value["coverage"],
        "readiness": value["readiness"],
    } == {"aggregate_queries": 0, "coverage": None, "readiness": None}


async def clone_legacy_content(case, template_id, identities):
    # Direct metadata seeding represents pre-index writers. Every clone retains
    # its real declared/finalized descriptor; no folded body or index is invented.
    async with case.factory.begin() as db:
        template = await db.get(AgentSessionContent, template_id)
        assert template is not None, "Legacy seed must derive from a real retained row"
        values = {
            column.name: getattr(template, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        for ordinal, identity in enumerate(identities, start=1):
            db.add(AgentSessionContent(**{
                **values,
                "id": identity,
                "content_key": hashlib.sha256(identity.bytes).hexdigest(),
                "source_order": ordinal,
                "received_chunks": dict(values["received_chunks"] or {}),
            }))
        await db.delete(template)
        await db.flush()
        # These synthetic cases contain exactly these clones plus any separately
        # declared control; session counters are not used as coverage answers.
        contents = (await db.scalars(select(AgentSessionContent).where(
            AgentSessionContent.session_id == template.session_id
        ))).all()
        await db.execute(update(AgentSession).where(
            AgentSession.id == template.session_id
        ).values(content_count=len(contents), content_bytes=sum(
            row.byte_count or 0 for row in contents
        )))


async def test_candidate_limited_verification_omits_coverage_without_skipping_later_object(
    observation_case,
):
    case, engine = observation_case
    needle = "OBSERVATION_COST_LATE_VERIFICATION"
    high_id = uuid.UUID(int=(1 << 128) - 1)
    identity, key, body = await case.historical("先🙂 " + needle, identity=high_id)
    store = LocalContentStore(settings.LOCAL_STORAGE_DIR)
    store.delete(key)
    prepared = await SessionSearchObjectProcessor(case.factory).prepare_source(identity)
    assert prepared.outcome == "missing_object"
    async with case.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_prepared_source(prepared) == "unavailable"
    store.put(key, body)
    ack = await case.declare(b"small historical pending upload")
    await clone_legacy_content(case, uuid.UUID(ack["content_id"]), [
        uuid.UUID(int=ordinal) for ordinal in range(1, 202)
    ])
    with capture_sql(case, engine, "start") as initial_sql:
        started = await case.start()
    assert_fresh_observation(started, initial_sql)
    assert started["coverage"]["pending_upload"]["count"] == 201
    assert started["coverage"]["unavailable"]["count"] == 1

    with capture_sql(case, engine, "candidate-limited pass") as first_sql:
        first = await case.step(started)
    assert first["pass"]["candidate_keys_examined"] == 200
    assert first["pass"]["sources_attempted"] == 0
    assert first["run"]["phase"] == "verify_unavailable"
    assert not first["progress"]["verification_complete"]
    assert case.io.stats == case.io.reads == []
    async with case.factory() as db:
        run = await db.get(SessionSearchBackfillRun, run_id(started))
        assert run.content_cursor == uuid.UUID(int=200)
        assert not run.content_exhausted and run.lease_expires_at is None
        source = await db.scalar(select(SessionSearchSource).where(
            SessionSearchSource.content_id == high_id
        ))
        assert source.status == "unavailable"

    # Complete the finite corpus before the new cost oracle, so a red preserves
    # both continued verification and exact retained-text retrieval evidence.
    final = await case.finish(started)
    assert final["verification"]["hash_verified_objects"] == 1
    assert final["coverage"]["pending_upload"]["count"] == 201
    page = await case.find(needle)
    assert [item["content_id"] for item in page["items"]] == [str(identity)]
    exact_match(page["items"][0], body.decode(), needle)
    assert_unobserved_pass(first, first_sql, reason="candidate_limit", exit_code=10)


@pytest.mark.parametrize("limiting_budget", ["sources", "bytes"])
async def test_processing_limited_pass_keeps_accounting_without_whole_scope_observation(
    observation_case, limiting_budget,
):
    case, engine = observation_case
    first_id, _key, body = await case.historical("small object A", identity=uuid.UUID(int=1))
    second_id, _key, second_body = await case.historical("small object B", identity=uuid.UUID(int=2))
    assert len(body) == len(second_body)
    started = await case.start()
    limits = {"source_limit": 1} if limiting_budget == "sources" else {"byte_budget": len(body) + 1}
    reason = "source_limit" if limiting_budget == "sources" else "byte_budget"
    with capture_sql(case, engine, reason) as sql:
        value = await case.step(started, **limits)
    assert value["pass"]["sources_attempted"] == 1
    assert value["pass"]["read_calls"] == 1
    assert value["pass"]["requested_bytes"] == len(body) + 1
    assert value["pass"]["returned_bytes"] == len(body)
    assert value["pass"]["reserved_bytes"] == len(body) + 1
    assert await indexed_count(case, first_id) == 1
    assert await indexed_count(case, second_id) == 0
    assert value["run"]["lease_expires_at"] is None
    with capture_sql(case, engine, "explicit status after bounded work") as status_sql:
        current = await case.status(started)
    assert_fresh_observation(current, status_sql)
    assert current["coverage"]["indexed"]["count"] == 1
    assert current["coverage"]["pending_index"]["count"] == 1
    assert_unobserved_pass(value, sql, reason=reason, exit_code=10)


@pytest.mark.parametrize("wait_kind", ["lease_busy", "retry_backoff"])
async def test_unfinished_wait_receipts_do_not_scan_corpus(observation_case, wait_kind):
    case, engine = observation_case
    identity, _key, body = await case.historical("small waiting object")
    started = await case.start()
    if wait_kind == "lease_busy":
        epoch = await driver(case.factory)._acquire_lease(run_id(started))
        assert epoch is not None
    else:
        case.io.fail_reads = True
        failed = await case.step(started, source_limit=1, byte_budget=len(body) + 1)
        assert failed["pass"]["read_calls"] == 1
        [claim] = await claims(case, started)
        assert claim["source_id"] == identity
        assert claim["state"] == "retry_wait" and claim["attempts"] == 1
    before_claims = await claims(case, started)
    with capture_sql(case, engine, wait_kind) as sql:
        waiting = await case.step(started)
    assert waiting["pass"]["sources_attempted"] == 0
    assert case.io.stats == case.io.reads == []
    assert await claims(case, started) == before_claims
    assert await indexed_count(case, identity) == 0
    if wait_kind == "lease_busy":
        assert waiting["run"]["lease_epoch"] == epoch
        assert waiting["run"]["lease_expires_at"] is not None
        # Busy has no worker stop; its reason and zero metrics still distinguish it.
        assert waiting["reason"] == "lease_busy" and waiting["exit_code"] == 11
        assert waiting["run"]["finished_at"] is None
        assert {
            "aggregate_queries": len(aggregate_statements(sql)),
            "coverage": waiting["coverage"], "readiness": waiting["readiness"],
        } == {"aggregate_queries": 0, "coverage": None, "readiness": None}
    else:
        assert_unobserved_pass(waiting, sql, reason="retry_backoff", exit_code=12)


async def test_start_status_and_finished_pass_observe_fresh_current_authorized_coverage(
    observation_case,
):
    case, engine = observation_case
    first_id, _key, body = await case.historical("first observed source")
    with capture_sql(case, engine, "created start") as start_sql:
        started = await case.start()
    assert_fresh_observation(started, start_sql)
    assert started["coverage"]["pending_index"] == {"count": 1, "bytes": len(body)}
    with capture_sql(case, engine, "terminal clean pass") as final_sql:
        final = await case.finish(started)
    assert_fresh_observation(final, final_sql)
    assert final["reason"] == "clean_observation"
    assert final["readiness"] == "ready_at_observation"
    assert await indexed_count(case, first_id) == 1

    second_id, _key, later_body = await case.historical("newly pending since finish")
    for label, operation in (
        ("idempotent start", case.start),
        ("status after new work", lambda: case.status(started)),
        ("finished pass after new work", lambda: case.step(started)),
    ):
        with capture_sql(case, engine, label) as sql:
            value = await operation()
        assert_fresh_observation(value, sql)
        assert value["run"]["id"] == started["run"]["id"]
        assert value["coverage"]["eligible_count"] == 2
        assert value["coverage"]["pending_index"] == {"count": 1, "bytes": len(later_body)}
        assert value["coverage"]["index_ready"] is False
        assert value["readiness"] == "exhausted_unready"
        if value["command"] == "start":
            assert value["result"] == "existing"
        else:
            assert value["reason"] == "pending_since_finish" and value["exit_code"] == 13
        assert case.io.stats == case.io.reads == []
    assert await indexed_count(case, second_id) == 0

    async with case.factory.begin() as db:
        await db.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == case.workspace.id,
            WorkspaceMember.user_id == case.owner.id,
        ))
    with capture_sql(case, engine, "status after owner revocation") as denied_sql:
        current = await case.status(started)
    assert_fresh_observation(current, denied_sql)
    assert current["coverage"]["eligible_count"] == 0
    assert current["coverage"]["owner_not_member_count"] == 2
    assert case.io.stats == case.io.reads == []
    assert not any(row["sql"].lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE"))
                   for row in denied_sql["statements"])


async def test_unresolved_metadata_terminal_pass_keeps_fresh_unknown_byte_coverage(
    observation_case,
):
    case, engine = observation_case
    identity, _key, _body = await case.historical("unknown historical size")
    async with case.factory.begin() as db:
        await db.execute(update(AgentSessionContent).where(
            AgentSessionContent.id == identity
        ).values(byte_count=None))
    started = await case.start()
    for attempt in range(4):
        with capture_sql(case, engine, f"metadata terminal attempt {attempt}") as sql:
            value = await case.step(started)
        if value["run"]["finished_at"] is not None:
            break
    assert value["run"]["finished_at"] is not None
    assert value["reason"] == "unresolved_metadata" and value["exit_code"] == 13
    assert_fresh_observation(value, sql)
    assert value["readiness"] == "exhausted_unready"
    assert value["coverage"]["pending_index"] == {"count": 1, "bytes": None}
    assert case.io.stats == case.io.reads == []


async def test_full_exhausted_claim_queue_finishes_with_fresh_coverage(observation_case):
    case, engine = observation_case
    template_id, _key, body = await case.historical("tiny retry exhaustion control")
    await clone_legacy_content(case, template_id, [uuid.UUID(int=n) for n in range(1, 27)])
    started = await case.start()
    case.io.fail_reads = True
    for attempt in range(1, 6):
        value = await case.step(started)
        rows = await claims(case, started)
        assert len(rows) == 25
        assert all(row["attempts"] == attempt for row in rows)
        assert value["pass"]["sources_attempted"] == 25
        assert value["pass"]["requested_bytes"] == 25 * (len(body) + 1)
        assert value["pass"]["returned_bytes"] == 0
        if attempt < 5:
            assert all(row["state"] == "retry_wait" for row in rows)
            async with case.factory.begin() as db:
                now = await SessionSearchBackfillRepository(db).clock()
                await db.execute(update(SessionSearchBackfillClaim).where(
                    SessionSearchBackfillClaim.run_id == run_id(started)
                ).values(next_attempt_at=now - timedelta(seconds=1)))
    assert all(row["state"] == "exhausted" for row in rows)
    with capture_sql(case, engine, "full claim queue terminal") as sql:
        final = await case.step(started)
    assert final["run"]["phase"] == "finished"
    assert final["reason"] == "claims_exhausted" and final["exit_code"] == 13
    assert not final["progress"]["discovery_complete"]
    assert final["progress"]["claims"]["exhausted"] == 25
    assert final["pass"]["sources_attempted"] == 0
    assert case.io.stats == case.io.reads == []
    assert await claims(case, started) == rows
    assert_fresh_observation(final, sql)
    assert final["readiness"] == "exhausted_unready"
    assert final["coverage"]["pending_index"] == {"count": 26, "bytes": 26 * len(body)}


async def test_observer_sees_fresh_coverage_when_another_worker_finishes_before_lease(
    observation_case, monkeypatch,
):
    case, engine = observation_case
    await case.historical("concurrent finish source")
    started = await case.start()
    original_acquire = backfill.SessionSearchBackfillService._acquire_lease
    schedule = {"injected": False}

    with capture_sql(case, engine, "concurrent finished observer") as sql:
        async def finish_before_observer_acquires(service, identity):
            if identity == run_id(started) and not schedule["injected"]:
                schedule["injected"] = True
                sql["actor"] = "concurrent_worker_and_producer"
                try:
                    # The outer service has observed unfinished state, but has
                    # not acquired a lease. A real separate service can finish.
                    with external_producer_interval(case):
                        finished = await case.finish(started)
                        assert finished["readiness"] == "ready_at_observation"
                        _id, _key, body = await case.historical("late pending after concurrent finish")
                        schedule["pending_bytes"] = len(body)
                finally:
                    sql["actor"] = "observer"
            return await original_acquire(service, identity)

        monkeypatch.setattr(
            backfill.SessionSearchBackfillService, "_acquire_lease",
            finish_before_observer_acquires,
        )
        observed = await case.step(started)
    assert schedule["injected"], "Did not reach the real pre-lease interleaving"
    assert aggregate_statements(sql, actor="concurrent_worker_and_producer")
    assert_fresh_observation(observed, sql)
    assert observed["run"]["id"] == started["run"]["id"]
    assert observed["run"]["phase"] == "finished"
    assert observed["reason"] == "pending_since_finish" and observed["exit_code"] == 13
    assert observed["coverage"]["pending_index"] == {"count": 1, "bytes": schedule["pending_bytes"]}
    assert observed["readiness"] == "exhausted_unready"
    assert observed["pass"]["sources_attempted"] == observed["pass"]["read_calls"] == 0
    assert observed["progress"]["outcomes"]["indexed"] == 1
    assert case.io.stats == case.io.reads == []


async def test_released_worker_observes_concurrent_finish_without_its_own_final_scope(
    observation_case, monkeypatch,
):
    case, engine = observation_case
    _identity, _key, body = await case.historical("released worker source")
    started = await case.start()
    original_run = backfill._Pass.run
    schedule = {"injected": False}

    with capture_sql(case, engine, "post-release finished observer") as sql:
        async def finish_after_worker_release(worker):
            stop = await original_run(worker)
            if worker.run_id == run_id(started) and not schedule["injected"]:
                assert stop == "source_limit" and worker.final_scope is None
                schedule["injected"] = True
                sql["actor"] = "concurrent_worker_and_producer"
                try:
                    with external_producer_interval(case):
                        # Do not use case.step here: it resets the IO meter,
                        # which already includes the outer worker's real read.
                        finished = receipt(await driver(case.factory).run_pass(run_id(started)))
                        assert finished["readiness"] == "ready_at_observation"
                        assert finished["pass"]["sources_attempted"] == 0
                        _id, _key, pending = await case.historical("pending after lease release")
                        schedule["pending_bytes"] = len(pending)
                finally:
                    sql["actor"] = "observer"
            return stop

        monkeypatch.setattr(backfill._Pass, "run", finish_after_worker_release)
        observed = await case.step(started, source_limit=1)
    assert schedule["injected"]
    assert aggregate_statements(sql, actor="concurrent_worker_and_producer")
    assert_fresh_observation(observed, sql)
    assert observed["run"]["phase"] == "finished"
    assert observed["run"]["finish_reason"] == "clean_observation"
    assert observed["coverage"]["pending_index"] == {"count": 1, "bytes": schedule["pending_bytes"]}
    assert observed["readiness"] == "exhausted_unready"
    # Keep the actual outer worker's stop/accounting, not the other worker's
    # result. Fresh observation does not retroactively perform more work.
    assert observed["reason"] == observed["pass"]["stop_reason"] == "source_limit"
    assert observed["pass"]["sources_attempted"] == 1
    assert observed["pass"]["requested_bytes"] == len(body) + 1
    assert observed["pass"]["returned_bytes"] == len(body)
    assert observed["progress"]["outcomes"]["indexed"] == 1
