# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent end-of-sweep races and pre-filter verification cursor bounds.

Scheduling wrappers call the real methods and return their results unchanged.
File-backed SQLite proves committed interleavings, not PostgreSQL lock waits.
"""

import hashlib
import json
import uuid
from contextlib import contextmanager
from pathlib import Path

import pytest
from sqlalchemy import delete, func, select, update

from app.config import settings
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.models.session_search_backfill import SessionSearchBackfillRun
from app.models.workspace import WorkspaceMember
from app.repositories.session_search_backfill import SessionSearchBackfillRepository
from app.services import session_search_backfill as backfill
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.session_search_text import EXTRACTOR_VERSION
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import upload
from tests.services.test_session_search_backfill import (
    capture as capture_fixture,
    db_engine as physical_db_engine,
    paused_object_indexing as paused_object_indexing_fixture,
    retained as retained_fixture,
    run_id,
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
async def review_case(retained, tmp_path, request):
    retained.evidence["review_test"] = request.node.name
    retained.evidence["review_test_sha256"] = hashlib.sha256(
        Path(__file__).read_bytes()
    ).hexdigest()
    try:
        yield retained
    finally:
        (tmp_path / "backfill-review-receipt.json").write_text(
            json.dumps(retained.evidence, indent=2) + "\n"
        )


@contextmanager
def external_producer_interval(case):
    # The worker is suspended. Only this producer's interval is excluded;
    # preceding and resumed worker reads still face RetainedCase.step's bounds.
    stats_before, reads_before = len(case.io.stats), len(case.io.reads)
    try:
        yield
    finally:
        reads = case.io.reads[reads_before:]
        case.evidence["observations"].append({
            "stage": "external_producer_after_no_unclaimed_work",
            "stat_calls": len(case.io.stats) - stats_before,
            "read_calls": len(reads),
            "unbounded_read_calls": sum(row["requested_bytes"] is None for row in reads),
            "bounded_requested_bytes": sum(
                row["requested_bytes"] for row in reads
                if row["requested_bytes"] is not None
            ),
            "returned_bytes": sum(row["returned_bytes"] for row in reads),
        })
        del case.io.stats[stats_before:]
        del case.io.reads[reads_before:]


def inject_after_empty_work_read(case, started, monkeypatch, producer):
    original_work_read = backfill._Pass._has_unclaimed_work
    original_aggregate = SessionSearchBackfillRepository.scope_aggregate
    observation = {"injected": False, "aggregates": []}
    case.evidence["end_of_sweep_race"] = observation

    async def read_then_commit(worker, claims):
        has_work = await original_work_read(worker, claims)
        if worker.run_id != run_id(started) or has_work or observation["injected"]:
            return has_work
        assert claims == [], "The race must begin without a deferred claim"
        async with case.factory() as db:
            run = await db.get(SessionSearchBackfillRun, worker.run_id)
            assert run is not None
            assert run.phase in {"discover", "reconcile"}
            assert run.content_exhausted and run.event_exhausted
            assert run.finished_at is None
        observation["empty_read_returned"] = has_work
        observation["injected"] = True
        # The real read's session has closed before the independent commit.
        with external_producer_interval(case):
            await producer()
        return has_work

    async def observe_real_aggregate(repo, **options):
        aggregate = await original_aggregate(repo, **options)
        if observation["injected"]:
            observation["aggregates"].append({
                "unresolved_metadata": aggregate.unresolved_metadata,
                "pending_content_count": sum(
                    row.count for row in aggregate.contents
                    if row.state == "available" and row.is_text
                    and row.index_status not in {"indexed", "unavailable", "not_text"}
                ),
            })
        return aggregate

    monkeypatch.setattr(backfill._Pass, "_has_unclaimed_work", read_then_commit)
    monkeypatch.setattr(
        SessionSearchBackfillRepository, "scope_aggregate", observe_real_aggregate
    )
    return observation


async def pass_through_race(case, started, observation):
    for _ in range(4):
        result = await case.step(started)
        if observation["injected"]:
            break
        assert result["run"]["finished_at"] is None, result
    assert observation["injected"], "Setup never reached the final no-work/coverage gap"
    assert observation["empty_read_returned"] is False
    assert observation["aggregates"], "The real coverage aggregate must observe the commit"
    assert observation["aggregates"][0] == {
        "unresolved_metadata": 0, "pending_content_count": 1,
    }
    assert result["progress"]["outcomes"]["invalid_metadata"] == 0
    assert result["run"]["finish_reason"] != "unresolved_metadata", result
    assert result["reason"] != "unresolved_metadata", result
    return result


async def test_end_of_sweep_late_finalize_reconciles_in_the_same_run(
    review_case, monkeypatch,
):
    case = review_case
    await case.historical("existing source before late upload")
    needle = "LATE_FINALIZE_AT_SWEEP_END"
    body = ("先🙂 " + needle + " exact retained body").encode()
    ack = await case.declare(body)
    identity = uuid.UUID(ack["content_id"])
    async with case.factory() as db:
        pending = await db.get(AgentSessionContent, identity)
        assert pending is not None and pending.state == "pending"
        assert await db.scalar(select(SessionSearchSource.id).where(
            SessionSearchSource.content_id == identity
        )) is None
    started = await case.start()
    assert started["coverage"]["pending_upload"]["count"] == 1

    async def finalize_pending_upload():
        completed = await upload(case.device_client, case.enrolled, ack, body)
        assert completed["state"] == "available", completed
        await case.db.commit()
        async with case.factory() as db:
            source = await db.scalar(select(SessionSearchSource).where(
                SessionSearchSource.content_id == identity
            ))
            assert source is not None and source.status == "pending"

    observation = inject_after_empty_work_read(
        case, started, monkeypatch, finalize_pending_upload
    )
    await pass_through_race(case, started, observation)
    final = await case.finish(started)
    assert final["run"]["id"] == started["run"]["id"]
    assert final["run"]["finish_reason"] == "clean_observation"
    assert final["coverage"]["pending_index"]["count"] == 0
    page = await case.find(needle)
    assert [item["content_id"] for item in page["items"]] == [str(identity)]
    exact_match(page["items"][0], body.decode(), needle)


async def test_end_of_sweep_membership_restoration_reconciles_old_pending_content(
    review_case, monkeypatch,
):
    case = review_case
    needle = "MEMBERSHIP_RESTORED_AT_SWEEP_END"
    identity, _key, body = await case.historical("先🙂 " + needle + " old body")
    async with case.factory.begin() as db:
        member = await db.get(WorkspaceMember, (case.workspace.id, case.owner.id))
        assert member is not None
        membership = {
            column.name: getattr(member, column.name)
            for column in WorkspaceMember.__table__.columns
        }
        await db.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == case.workspace.id,
            WorkspaceMember.user_id == case.owner.id,
        ))
    denied = await case.client.post(f"{case.path}/search", json={"q": needle})
    assert denied.status_code == 403
    assert needle not in denied.text
    await case.db.commit()
    started = await case.start()
    assert started["coverage"]["owner_not_member_count"] == 1
    assert started["coverage"]["pending_index"]["count"] == 0

    async def restore_membership():
        assert case.io.stats == case.io.reads == [], "Excluded sources must not be read"
        async with case.factory.begin() as db:
            db.add(WorkspaceMember(**membership))

    observation = inject_after_empty_work_read(
        case, started, monkeypatch, restore_membership
    )
    await pass_through_race(case, started, observation)
    final = await case.finish(started)
    assert final["run"]["id"] == started["run"]["id"]
    assert final["coverage"]["owner_not_member_count"] == 0
    assert final["coverage"]["pending_index"]["count"] == 0
    page = await case.find(needle)
    assert [item["content_id"] for item in page["items"]] == [str(identity)]
    exact_match(page["items"][0], body.decode(), needle)


async def test_verification_advances_only_the_first_200_keys_before_index_filtering(
    review_case, monkeypatch,
):
    case = review_case
    high_id = uuid.UUID(int=(1 << 128) - 1)
    needle = "HIGH_UUID_TERMINAL_VERIFICATION"
    identity, key, body = await case.historical("先🙂 " + needle, identity=high_id)
    store = LocalContentStore(settings.LOCAL_STORAGE_DIR)
    store.delete(key)
    prepared = await SessionSearchObjectProcessor(case.factory).prepare_source(identity)
    assert prepared.outcome == "missing_object"
    async with case.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_prepared_source(prepared) == "unavailable"
    store.put(key, body)

    pending_body = b"nonmatching pending upload metadata"
    pending_ack = await case.declare(pending_body)
    async with case.factory.begin() as db:
        template = await db.get(AgentSessionContent, uuid.UUID(pending_ack["content_id"]))
        assert template is not None and template.state == "pending"
        pending_values = {
            column.name: getattr(template, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        await db.delete(template)
        await db.flush()
        # Valid historical pending declarations; no body or index row is
        # fabricated. Their UUID order puts all 250 before the real unavailable
        # source. Session counters mirror these directly seeded legacy rows.
        for ordinal in range(1, 251):
            source_id = uuid.UUID(int=ordinal)
            db.add(AgentSessionContent(**{
                **pending_values,
                "id": source_id,
                "content_key": hashlib.sha256(source_id.bytes).hexdigest(),
                "source_order": ordinal,
                "received_chunks": {},
            }))
        await db.execute(update(AgentSession).where(
            AgentSession.id == case.session_id
        ).values(content_count=251, content_bytes=len(body) + 250 * len(pending_body)))
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentSessionContent)) == 251
        terminal = await db.scalar(select(SessionSearchSource).where(
            SessionSearchSource.content_id == high_id
        ))
        assert terminal is not None and terminal.status == "unavailable"
        assert terminal.extractor_version == EXTRACTOR_VERSION
        assert terminal.source_digest == hashlib.sha256(body).hexdigest()
        assert await db.scalar(select(func.count()).select_from(SessionSearchSource)) == 1

    started = await case.start()
    assert started["run"]["phase"] == "verify_unavailable"
    assert started["coverage"]["pending_upload"]["count"] == 250
    assert started["coverage"]["unavailable"]["count"] == 1
    original_candidates = SessionSearchBackfillRepository.content_candidates
    observed = []
    case.evidence["candidate_batches"] = []

    async def observe_candidates(repo, **options):
        candidates = await original_candidates(repo, **options)
        observed.append((dict(options), candidates))
        case.evidence["candidate_batches"].append({
            "verification": options["recorded_unavailable_in"] is not None,
            "limit": options["limit"],
            "returned_count": len(candidates),
            "low_ordinal_keys": [row.id.int for row in candidates if row.id != high_id],
            "includes_high_unavailable": any(row.id == high_id for row in candidates),
        })
        return candidates

    monkeypatch.setattr(
        SessionSearchBackfillRepository, "content_candidates", observe_candidates
    )
    first = await case.step(started)
    async with case.factory() as db:
        progress = await db.get(SessionSearchBackfillRun, run_id(started))
        assert progress is not None
        case.evidence["first_verification_progress"] = {
            "phase": progress.phase,
            "cursor_is_200": progress.content_cursor == uuid.UUID(int=200),
            "exhausted": progress.content_exhausted,
        }
        first_cursor = progress.content_cursor
        first_exhausted = progress.content_exhausted
    assert observed and observed[0][0]["recorded_unavailable_in"] == EXTRACTOR_VERSION
    assert observed[0][0]["limit"] == 200
    assert [row.id for row in observed[0][1]] == [uuid.UUID(int=i) for i in range(1, 201)]
    assert all(row.member and row.state == "pending" and row.index_status is None for row in observed[0][1])
    assert first["pass"]["candidate_keys_examined"] == 200
    assert first["pass"]["sources_attempted"] == 0
    assert first["pass"]["stat_calls"] == first["pass"]["read_calls"] == 0
    assert first["run"]["phase"] == "verify_unavailable"
    assert first_cursor == uuid.UUID(int=200)
    assert first_exhausted is False
    assert first["progress"]["verification_complete"] is False
    assert first["verification"]["attempted_objects"] == 0
    final = await case.finish(started)
    assert final["verification"]["attempted_objects"] == 1
    assert final["verification"]["hash_verified_objects"] == 1
    assert final["coverage"]["pending_upload"]["count"] == 250
    assert final["coverage"]["unavailable"]["count"] == 0
    page = await case.find(needle)
    assert [item["content_id"] for item in page["items"]] == [str(high_id)]
    exact_match(page["items"][0], body.decode(), needle)
