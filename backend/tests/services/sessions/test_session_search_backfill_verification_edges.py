# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Verification receipts and late finalization beside a retained failed claim.

File-backed SQLite proves committed service interleavings here, not PostgreSQL
lock waits. Scheduling wrappers return the real eligibility/aggregate results.
"""

import hashlib
import json
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import select

from app.config import settings
from app.core.time import as_utc
from app.models.agent_session import AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.models.session_search_backfill import (
    SessionSearchBackfillClaim,
    SessionSearchBackfillRun,
)
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.services import session_search_backfill as backfill
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import upload
from tests.services.test_session_search_backfill import (
    OUTCOMES,
    capture as capture_fixture,
    claims,
    db_engine as physical_db_engine,
    indexed_count,
    paused_object_indexing as paused_object_indexing_fixture,
    retained as retained_fixture,
    run_id,
)
from tests.services.test_session_search_backfill_review import (
    external_producer_interval,
)
from tests.test_session_search import exact_match

capture = capture_fixture
db_engine = physical_db_engine
paused_object_indexing = paused_object_indexing_fixture
retained = retained_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]


@pytest.fixture
async def edge_case(retained, tmp_path, request):
    backend = Path(__file__).resolve().parents[3]
    retained.evidence["verification_edge"] = {
        "test": request.node.name,
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "source_sha256": {
            name: hashlib.sha256((backend / name).read_bytes()).hexdigest()
            for name in (
                "app/services/session_search_backfill.py",
                "app/repositories/session_search_backfill.py",
                "app/services/session_search_index.py",
            )
        },
    }
    try:
        yield retained
    finally:
        (tmp_path / "backfill-verification-edge-receipt.json").write_text(
            json.dumps(retained.evidence, indent=2) + "\n"
        )


async def make_retry_due(case, started, identity, *, attempts):
    # Advance only this durable retry's due time; keep the real failure count,
    # identity, run cursors and lease unchanged. No wall-clock sleeps are needed.
    async with case.factory.begin() as db:
        claim = await db.get(
            SessionSearchBackfillClaim, (run_id(started), "content", identity)
        )
        assert claim is not None and claim.state == "retry_wait"
        assert claim.attempts == attempts
        now = await SessionSearchBackfillRepository(db).clock()
        assert as_utc(claim.next_attempt_at) > now
        claim.next_attempt_at = now - timedelta(seconds=1)


def verification_counts(value):
    return {
        name: value["verification"][name]
        for name in (
            "attempted_objects",
            "hash_verified_objects",
            "hash_verified_bytes",
            "missing_objects",
            "mismatch_objects",
            "storage_errors",
        )
    }


async def test_verification_counts_transient_failure_and_successful_retry(edge_case):
    case = edge_case
    needle = "VERIFICATION_RETRY_RESTORED_TEXT"
    identity, key, body = await case.historical("先🙂 " + needle)
    store = LocalContentStore(settings.LOCAL_STORAGE_DIR)
    store.delete(key)
    prepared = await SessionSearchObjectProcessor(case.factory).prepare_source(identity)
    assert prepared.outcome == "missing_object"
    async with case.factory.begin() as db:
        assert (
            await SessionSearchIndexWriter(db).index_prepared_source(prepared)
            == "unavailable"
        )
    store.put(key, body)

    started = await case.start()
    assert started["run"]["phase"] == "verify_unavailable"
    assert started["coverage"]["unavailable"] == {"count": 1, "bytes": len(body)}
    assert started["coverage"]["index_ready"] is True
    assert started["readiness"] == "in_progress"
    budget = len(body) + 1

    case.io.fail_reads = True
    failed = await case.step(started, source_limit=1, byte_budget=budget)
    [claim] = await claims(case, started)
    assert claim["source_id"] == identity
    assert (claim["state"], claim["attempts"], claim["reason"]) == (
        "retry_wait",
        1,
        "storage_unavailable",
    )
    assert failed["run"]["phase"] == "verify_unavailable"
    assert failed["coverage"] is None
    assert failed["readiness"] is None
    assert failed["pass"]["requested_bytes"] == budget
    assert failed["pass"]["returned_bytes"] == 0
    assert failed["pass"]["read_calls"] == 1
    assert failed["progress"]["outcomes"] == dict.fromkeys(OUTCOMES, 0) | {
        "retry_wait": 1
    }
    assert await indexed_count(case, identity) == 0

    observed = await case.status(started)
    waiting = await case.step(started, source_limit=1, byte_budget=budget)
    assert waiting["exit_code"] == 12 and waiting["reason"] == "retry_backoff"
    assert waiting["pass"]["sources_attempted"] == 0
    assert case.io.stats == case.io.reads == []
    assert await claims(case, started) == [claim]

    await make_retry_due(case, started, identity, attempts=1)
    case.io.fail_reads = False
    recovered = await case.step(started, source_limit=1, byte_budget=budget)
    assert recovered["pass"]["read_calls"] == 1
    assert recovered["pass"]["requested_bytes"] == budget
    assert recovered["pass"]["returned_bytes"] == len(body)
    assert recovered["progress"]["outcomes"] == dict.fromkeys(OUTCOMES, 0) | {
        "retry_wait": 1,
        "indexed": 1,
    }
    assert await claims(case, started) == []
    assert await indexed_count(case, identity) == 1

    final = await case.finish(started, source_limit=1, byte_budget=budget)
    current = await case.status(started)
    assert final["run"]["id"] == started["run"]["id"]
    assert final["run"]["finish_reason"] == "clean_observation"
    assert final["coverage"]["unavailable"]["count"] == 0
    assert current["verification"] == final["verification"]
    page = await case.find(needle)
    assert [item["content_id"] for item in page["items"]] == [str(identity)]
    exact_match(page["items"][0], body.decode(), needle)
    assert (
        sum(row["pass"]["requested_bytes"] for row in case.evidence["passes"])
        == 2 * budget
    )
    assert sum(row["pass"]["returned_bytes"] for row in case.evidence["passes"]) == len(
        body
    )

    # Complete the successful recovery before the counter oracle, so a failure
    # records both actual probes rather than stopping at the first undercount.
    actual_counts = [
        verification_counts(value)
        for value in (failed, observed, waiting, recovered, final, current)
    ]
    case.evidence["verification_edge"]["observed_counter_sequence"] = actual_counts
    first_probe = {
        "attempted_objects": 1,
        "hash_verified_objects": 0,
        "hash_verified_bytes": 0,
        "missing_objects": 0,
        "mismatch_objects": 0,
        "storage_errors": 1,
    }
    both_probes = first_probe | {
        "attempted_objects": 2,
        "hash_verified_objects": 1,
        "hash_verified_bytes": len(body),
    }
    assert actual_counts == [first_probe] * 3 + [both_probes] * 3


async def test_late_finalize_is_processed_before_finishing_with_exhausted_claim(
    edge_case,
    monkeypatch,
):
    case = edge_case
    blocked_id, _key, blocked_body = await case.historical("durable exhausted object")
    needle = "LATE_FINALIZE_BESIDE_EXHAUSTED_CLAIM"
    late_body = ("先🙂 " + needle).encode()
    ack = await case.declare(late_body)
    late_id = uuid.UUID(ack["content_id"])
    async with case.factory() as db:
        pending = await db.get(AgentSessionContent, late_id)
        assert pending is not None and pending.state == "pending"
        assert (
            await db.scalar(
                select(SessionSearchSource.id).where(
                    SessionSearchSource.content_id == late_id
                )
            )
            is None
        )

    started = await case.start()
    assert started["coverage"]["pending_upload"]["count"] == 1
    budget = max(len(blocked_body), len(late_body)) + 1
    case.io.fail_reads = True
    for attempt in range(1, 6):
        failed = await case.step(started, source_limit=1, byte_budget=budget)
        [claim] = await claims(case, started)
        assert claim["source_id"] == blocked_id and claim["attempts"] == attempt
        assert failed["pass"]["sources_attempted"] == 1
        assert failed["pass"]["requested_bytes"] == len(blocked_body) + 1
        assert failed["pass"]["returned_bytes"] == 0
        assert failed["run"]["finished_at"] is None
        assert failed["coverage"] is None
        assert failed["readiness"] is None
        if attempt < 5:
            await make_retry_due(case, started, blocked_id, attempts=attempt)
    assert (claim["state"], claim["next_attempt_at"], claim["reason"]) == (
        "exhausted",
        None,
        "storage_unavailable",
    )
    exhausted_claim = dict(claim)
    assert failed["progress"]["outcomes"] == dict.fromkeys(OUTCOMES, 0) | {
        "retry_wait": 4,
        "exhausted": 1,
    }
    case.io.fail_reads = False

    original_work_read = backfill._Pass._has_unclaimed_work
    original_aggregate = SessionSearchBackfillRepository.scope_aggregate
    observation = {"injected": False, "aggregates": []}
    case.evidence["verification_edge"]["sweep_race"] = observation

    async def finalize_after_real_empty_read(worker, retained_claims):
        has_work = await original_work_read(worker, retained_claims)
        if worker.run_id != run_id(started) or has_work or observation["injected"]:
            return has_work
        assert len(retained_claims) == 1
        assert retained_claims[0].source_id == blocked_id
        assert retained_claims[0].state == "exhausted"
        assert await claims(case, started) == [exhausted_claim]
        async with case.factory() as db:
            run = await db.get(SessionSearchBackfillRun, worker.run_id)
            assert run is not None and run.phase in {"discover", "reconcile"}
            assert run.content_exhausted and run.event_exhausted
            assert run.finished_at is None
        observation["injected"] = True
        observation["empty_read_returned"] = has_work
        # The real eligibility read has closed its DB session. This upload is
        # another producer, not worker I/O; keep its counts in separate evidence.
        with external_producer_interval(case):
            completed = await upload(case.device_client, case.enrolled, ack, late_body)
            assert completed["state"] == "available", completed
            await case.db.commit()
        async with case.factory() as db:
            source = await db.scalar(
                select(SessionSearchSource).where(
                    SessionSearchSource.content_id == late_id
                )
            )
            assert source is not None and source.status == "pending"
        return has_work

    async def observe_real_aggregate(repo, **options):
        aggregate = await original_aggregate(repo, **options)
        if observation["injected"]:
            observation["aggregates"].append(
                {
                    "unresolved_metadata": aggregate.unresolved_metadata,
                    "pending_content_count": sum(
                        row.count
                        for row in aggregate.contents
                        if row.state == "available"
                        and row.is_text
                        and row.index_status
                        not in {"indexed", "unavailable", "not_text"}
                    ),
                }
            )
        return aggregate

    monkeypatch.setattr(
        backfill._Pass, "_has_unclaimed_work", finalize_after_real_empty_read
    )
    monkeypatch.setattr(
        SessionSearchBackfillRepository, "scope_aggregate", observe_real_aggregate
    )
    for _ in range(4):
        final = await case.step(started, source_limit=1, byte_budget=budget)
        if final["run"]["phase"] == "finished":
            break
    assert observation["injected"], "Setup must reach the actual no-work/coverage gap"
    assert observation["empty_read_returned"] is False
    assert observation["aggregates"][0] == {
        "unresolved_metadata": 0,
        "pending_content_count": 2,
    }
    assert final["run"]["id"] == started["run"]["id"]
    assert final["run"]["phase"] == "finished"
    assert final["run"]["finish_reason"] == "claims_exhausted"
    assert final["reason"] == "claims_exhausted" and final["exit_code"] == 13
    assert final["readiness"] == "exhausted_unready"
    assert final["progress"]["claims"] == {
        "outstanding": 1,
        "due": 0,
        "exhausted": 1,
        "next_attempt_at": None,
    }
    assert await claims(case, started) == [exhausted_claim]
    assert await indexed_count(case, blocked_id) == 0
    current = await case.status(started)
    page = await case.find(needle)
    case.evidence["verification_edge"]["late_source_observation"] = {
        "indexed_count": await indexed_count(case, late_id),
        "search_hit_count": len(page["items"]),
        "final_pending": final["coverage"]["pending_index"],
        "current_pending": current["coverage"]["pending_index"],
        "exhausted_claim_unchanged": await claims(case, started) == [exhausted_claim],
    }

    assert final["coverage"]["pending_index"] == {
        "count": 1,
        "bytes": len(blocked_body),
    }
    assert final["coverage"]["indexed"] == {"count": 1, "bytes": len(late_body)}
    assert current["coverage"] == final["coverage"] | {
        "observed_from": current["coverage"]["observed_from"],
        "observed_at": current["coverage"]["observed_at"],
    }
    assert final["progress"]["outcomes"] == dict.fromkeys(OUTCOMES, 0) | {
        "retry_wait": 4,
        "exhausted": 1,
        "indexed": 1,
    }
    assert final["progress"]["discovery_complete"] is True
    assert final["progress"]["verification_complete"] is True
    assert [item["content_id"] for item in page["items"]] == [str(late_id)]
    exact_match(page["items"][0], late_body.decode(), needle)
    assert sum(row["pass"]["sources_attempted"] for row in case.evidence["passes"]) == 6
    assert sum(row["pass"]["requested_bytes"] for row in case.evidence["passes"]) == (
        5 * (len(blocked_body) + 1) + len(late_body) + 1
    )
    assert sum(row["pass"]["returned_bytes"] for row in case.evidence["passes"]) == len(
        late_body
    )
