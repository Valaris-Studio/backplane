# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01H historical discovery through real retained bodies and owner search.

The first control needs only landed B01. Driver imports are deliberately late:
an absent driver must not hide the observable old-body search gap at collection.
SQLite proves owned commits and sequential recovery here; PostgreSQL must still
qualify competing leases, database-clock expiry and lock-wait ordering.
"""

import hashlib
import importlib
import json
import uuid
import weakref
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, event, func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app import database
from app.config import settings
from app.models.agent_session import AgentSession, AgentSessionContent
from app.models.base import Base
from app.models.session_search import SessionSearchChunk, SessionSearchSource
from app.models.workspace import WorkspaceMember
from app.services.session_search_index import (
    SessionSearchIndexWriter,
    SessionSearchObjectProcessor,
)
from app.services.storage.session_content import LocalContentStore
from tests.rich_capture import declaration, sessions_path, upload
from tests.test_session_search import (
    capture as capture_fixture,
    exact_match,
    paused_object_indexing as paused_object_indexing_fixture,
    search,
    store_contents,
)

capture = capture_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

MARKER = "Straße_HISTORICAL_BEYOND_PREVIEW"
HISTORICAL_TEXT = "先🙂" + "ordinary " * 120_000 + MARKER + " ending"
OUTCOMES = {
    "indexed", "unchanged", "unavailable", "not_text", "absent", "stale",
    "owner_not_member", "invalid_metadata", "retry_wait", "exhausted",
}


@pytest.fixture
async def db_engine(tmp_path, monkeypatch):
    # Independent connections must not see a claim until its transaction has
    # committed. The shared :memory:/StaticPool fixture cannot prove that seam.
    path = tmp_path / "backfill.sqlite3"
    engine = create_async_engine(f"sqlite+aiosqlite:///{path}", poolclass=NullPool)

    @event.listens_for(engine.sync_engine, "connect")
    def enforce_foreign_keys(connection, _record):
        cursor = connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    monkeypatch.setattr(
        database, "async_session", async_sessionmaker(engine, expire_on_commit=False)
    )
    try:
        yield engine
    finally:
        await engine.dispose()
        path.unlink(missing_ok=True)


class InterruptedWorker(BaseException):
    """A stopped process, outside ordinary retryable storage exceptions."""


def driver(factory):
    module = importlib.import_module("app.services.session_search_backfill")
    return module.SessionSearchBackfillService(factory)


def receipt(value):
    result = value.model_dump(mode="json", by_alias=True)
    assert result["schema"] == "session-search-backfill/1"
    assert result["command"] in {"start", "pass", "status"}
    common = {
        "schema", "command", "result", "exit_code", "reason", "observed_at",
        "run", "progress", "coverage", "verification", "readiness",
    }
    assert set(result) == common | ({"pass"} if result["command"] == "pass" else set())
    assert isinstance(result["result"], str)
    assert isinstance(result["exit_code"], int)
    assert isinstance(result["reason"], str)
    assert isinstance(result["observed_at"], str)
    assert result["readiness"] in {
        None, "in_progress", "ready_at_observation", "exhausted_unready",
    }
    if result["command"] == "pass":
        assert set(result["pass"]) == {
            "source_limit", "byte_budget", "sources_attempted", "candidate_keys_examined",
            "reserved_bytes", "requested_bytes", "returned_bytes", "stat_calls",
            "read_calls", "stop_reason",
        }
    # Validation can refuse before a run is read. Do not require invented
    # coverage or progress in that receipt; observed runs retain the full shape.
    if result["run"] is None:
        assert result["result"] == "refused"
        assert all(result[name] is None for name in (
            "progress", "coverage", "verification", "readiness",
        ))
        return result
    assert set(result["run"]) == {
        "id", "scope", "extractor_version", "store_fingerprint", "phase", "sweep",
        "created", "predecessor_id", "successor_id", "lease_epoch", "lease_expires_at",
        "created_at", "finished_at", "finish_reason",
    }
    assert set(result["progress"]) == {
        "outcomes", "claims", "discovery_complete", "verification_complete",
    }
    assert set(result["progress"]["outcomes"]) == OUTCOMES
    assert set(result["progress"]["claims"]) == {
        "outstanding", "due", "exhausted", "next_attempt_at",
    }
    assert set(result["verification"]) == {
        "epoch_id", "started_at", "finished_at", "attempted_objects",
        "hash_verified_objects", "hash_verified_bytes", "missing_objects",
        "mismatch_objects", "storage_errors",
    }
    assert result["verification"]["epoch_id"] == result["run"]["id"]
    if result["coverage"] is None:
        assert result["readiness"] is None
    else:
        buckets = {
            "indexed", "pending_index", "pending_upload", "withheld", "uncaptured",
            "unavailable", "nontext", "available", "eligible",
        }
        assert set(result["coverage"]) == buckets | {
            "eligible_count", "child_metadata_count", "owner_not_member_count",
            "extractor_version", "observed_from", "observed_at", "index_ready",
        }
        for name in buckets:
            assert set(result["coverage"][name]) == {"count", "bytes"}
    return result


def run_id(value):
    return uuid.UUID(value["run"]["id"])


class BodyIO:
    def __init__(self, monkeypatch):
        self.stats = []
        self.reads = []
        self.fail_reads = False
        original_stat = LocalContentStore.stat
        original_read = LocalContentStore.read

        def stat(store, key):
            self.stats.append(key)
            return original_stat(store, key)

        def read(store, key, offset=0, length=None):
            observed = {"offset": offset, "requested_bytes": length, "returned_bytes": 0}
            self.reads.append(observed)
            if self.fail_reads:
                raise OSError("SYNTHETIC_STORAGE_FAILURE_NO_PRIVATE_BODY")
            body = original_read(store, key, offset, length)
            observed["returned_bytes"] = len(body)
            return body

        monkeypatch.setattr(LocalContentStore, "stat", stat)
        monkeypatch.setattr(LocalContentStore, "read", read)

    def clear(self):
        self.stats.clear()
        self.reads.clear()


class RetainedCase:
    def __init__(self, client, device_client, db, factory, workspace, owner, enrolled, io):
        self.client = client
        self.device_client = device_client
        self.db = db
        self.factory = factory
        self.workspace = workspace
        self.owner = owner
        self.enrolled = enrolled
        self.io = io
        self.path = None
        self.session_id = None
        self.evidence = {"observations": [], "passes": []}

    async def declare(self, body):
        [ack] = await store_contents(
            self.device_client, self.enrolled, [declaration(body, delivery="upload")]
        )
        assert ack["outcome"] == "upload_required", ack
        await self.db.commit()
        return ack

    async def historical(self, text=HISTORICAL_TEXT, *, identity=None):
        body = text.encode()
        ack = await self.declare(body)
        settled = await upload(self.device_client, self.enrolled, ack, body)
        assert settled["state"] == "available", settled
        template = await self.db.get(AgentSessionContent, uuid.UUID(ack["content_id"]))
        values = {
            column.name: getattr(template, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        identity = identity or uuid.uuid4()
        values.update(
            id=identity,
            content_key=hashlib.sha256(identity.bytes).hexdigest(),
            occurred_at=template.occurred_at - timedelta(days=90),
            observed_at=template.observed_at - timedelta(days=90),
            received_at=template.received_at - timedelta(days=90),
        )
        # Retain a real finalized object's descriptor under an old source row.
        # Direct insertion models an old writer: it creates no search record.
        await self.db.delete(template)
        await self.db.flush()
        self.db.add(AgentSessionContent(**values))
        await self.db.commit()
        self.session_id = values["session_id"]
        self.path = sessions_path(self.workspace, self.session_id)
        async with self.factory.begin() as db:
            assert await db.scalar(
                select(func.count()).select_from(SessionSearchSource).where(
                    SessionSearchSource.content_id == identity
                )
            ) == 0
        return identity, values["storage_key"], body

    async def find(self, query=MARKER.casefold()):
        page = await search(self.client, self.path, query)
        await self.db.commit()
        return page

    async def baseline(self, identity, body):
        metadata = await self.client.get(f"{self.path}/contents")
        first = await self.client.get(f"{self.path}/contents/{identity}/body")
        assert metadata.status_code == first.status_code == 200
        assert str(identity) in {item["id"] for item in metadata.json()["items"]}
        assert MARKER not in json.dumps(metadata.json())
        assert first.json()["text"].encode() == body[: len(first.json()["text"].encode())]
        assert MARKER not in first.json()["text"]
        page = await self.find()
        assert page["items"] == []
        assert page["coverage"]["pending_index"] == {"count": 1, "bytes": len(body)}
        assert page["coverage"]["index_ready"] is False
        self.evidence["observations"].append({
            "stage": "landed_b01_historical_gap",
            "retained_bytes": len(body),
            "match_byte_start": body.index(MARKER.encode()),
            "first_body_page_bytes": len(first.json()["text"].encode()),
            "search_hit_count": len(page["items"]),
            "coverage": page["coverage"],
        })

    async def start(self, **options):
        self.io.clear()
        value = receipt(await driver(self.factory).start_run(scope="all_workspaces", **options))
        assert self.io.stats == self.io.reads == []
        return value

    async def status(self, started):
        self.io.clear()
        value = receipt(await driver(self.factory).status(run_id(started)))
        assert self.io.stats == self.io.reads == []
        return value

    async def step(self, started, *, source_limit=25, byte_budget=67_108_864):
        self.io.clear()
        value = receipt(await driver(self.factory).run_pass(
            run_id(started), source_limit=source_limit, byte_budget=byte_budget
        ))
        measured = value["pass"]
        assert 0 <= measured["sources_attempted"] <= source_limit
        assert 0 <= measured["candidate_keys_examined"] <= 200
        assert measured["source_limit"] == source_limit
        assert measured["byte_budget"] == byte_budget
        assert all(row["requested_bytes"] is not None for row in self.io.reads)
        requested = sum(row["requested_bytes"] for row in self.io.reads)
        assert requested <= byte_budget
        assert measured["requested_bytes"] == requested
        assert measured["returned_bytes"] == sum(row["returned_bytes"] for row in self.io.reads)
        assert measured["stat_calls"] == len(self.io.stats)
        assert measured["read_calls"] == len(self.io.reads)
        assert len(self.io.stats) <= source_limit
        assert value["progress"]["claims"]["outstanding"] <= 25
        self.evidence["passes"].append(value)
        return value

    async def finish(self, started, **limits):
        # A finite synthetic corpus gets a finite number of externally invoked
        # passes. This is a test liveness bound, not an implementation driver.
        for _ in range(16):
            value = await self.step(started, **limits)
            if value["run"]["phase"] == "finished":
                assert value["readiness"] == "ready_at_observation", value
                assert value["coverage"]["index_ready"] is True
                assert value["progress"]["discovery_complete"] is True
                assert value["progress"]["verification_complete"] is True
                assert value["progress"]["claims"]["outstanding"] == 0
                return value
        pytest.fail("Finite fixture remained unfinished after sixteen bounded passes")


@pytest.fixture
async def retained(
    client, device_client, db_session, db_engine, test_workspace, test_user,
    capture, monkeypatch, tmp_path, request,
):
    case = RetainedCase(
        client, device_client, db_session,
        async_sessionmaker(db_engine, expire_on_commit=False),
        test_workspace, test_user, capture, BodyIO(monkeypatch),
    )
    try:
        yield case
    finally:
        case.evidence["test"] = request.node.name
        case.evidence["test_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        (tmp_path / "backfill-regression-receipt.json").write_text(
            json.dumps(case.evidence, indent=2) + "\n"
        )


async def claims(case, started):
    table = Base.metadata.tables["session_search_backfill_claims"]
    async with case.factory.begin() as db:
        return (await db.execute(select(table).where(table.c.run_id == run_id(started)))).mappings().all()


async def expire_lease(case, started):
    table = Base.metadata.tables["session_search_backfill_runs"]
    async with case.factory.begin() as db:
        now = await db.scalar(select(func.current_timestamp()))
        await db.execute(update(table).where(table.c.id == run_id(started)).values(
            lease_expires_at=now - timedelta(minutes=1)
        ))


async def indexed_count(case, identity):
    async with case.factory.begin() as db:
        return await db.scalar(select(func.count()).select_from(SessionSearchSource).where(
            SessionSearchSource.content_id == identity,
            SessionSearchSource.status == "indexed",
        ))


async def test_landed_b01_diagnostic_old_object_gap_and_exact_writer_control(retained):
    identity, _key, body = await retained.historical()
    await retained.baseline(identity, body)
    prepared = await SessionSearchObjectProcessor(retained.factory).prepare_source(identity)
    assert prepared.outcome == "ready"
    async with retained.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_prepared_source(prepared) == "indexed"
    page = await retained.find()
    [item] = page["items"]
    assert item["content_id"] == str(identity)
    exact_match(item, body.decode(), MARKER)
    assert page["coverage"]["index_ready"] is True
    retained.evidence["observations"].append({
        "stage": "landed_b01_exact_writer_control",
        "search_hit_count": len(page["items"]),
        "byte_start": item["byte_start"], "byte_end": item["byte_end"],
    })


async def test_backfill_discovers_old_object_beyond_preview_with_exact_utf8_anchor(retained):
    identity, _key, body = await retained.historical()
    await retained.baseline(identity, body)
    started = await retained.start()
    assert started["readiness"] != "ready_at_observation"
    await retained.finish(started)
    [item] = (await retained.find())["items"]
    assert item["source_id"] == item["content_id"] == str(identity)
    exact_match(item, body.decode(), MARKER)


async def test_start_finished_pass_and_status_are_idempotent_without_body_work(retained):
    identity, _key, _body = await retained.historical("idempotent old object")
    started = await retained.start()
    again = await retained.start()
    assert again["run"]["id"] == started["run"]["id"]
    assert again["result"] == "existing"
    finished = await retained.finish(started)
    first = await retained.find("idempotent")
    retained.io.clear()
    status = await retained.status(started)
    assert status["readiness"] == "ready_at_observation"
    assert retained.io.reads == retained.io.stats == []
    repeated = await retained.step(started)
    assert repeated["pass"]["sources_attempted"] == 0
    assert repeated["progress"]["outcomes"] == finished["progress"]["outcomes"]
    assert retained.io.reads == retained.io.stats == []
    assert (await retained.start())["run"]["id"] == started["run"]["id"]
    assert await indexed_count(retained, identity) == 1
    assert (await retained.find("idempotent"))["generation"] == first["generation"]


async def test_crash_after_durable_claim_resumes_with_new_service_instance(retained, monkeypatch):
    identity, _key, _body = await retained.historical("restart-safe body")
    started = await retained.start()
    original = SessionSearchObjectProcessor.prepare_source
    observed = []

    async def stop_after_claim(processor, content_id, **options):
        rows = await claims(retained, started)
        assert any(row["source_id"] == content_id for row in rows)
        assert len(rows) <= 25
        observed.extend(rows)
        raise InterruptedWorker()

    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", stop_after_claim)
    with pytest.raises(InterruptedWorker):
        for _ in range(4):
            await retained.step(started, source_limit=1)
    assert observed, "Crash injection must occur after a committed real claim"
    assert await indexed_count(retained, identity) == 0
    assert len(await claims(retained, started)) == 1
    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", original)
    await expire_lease(retained, started)
    await retained.finish(started, source_limit=1)
    assert await indexed_count(retained, identity) == 1
    assert len((await retained.find("restart-safe"))["items"]) == 1


@pytest.mark.parametrize("boundary", ["payload_only", "payload_plus_sentinel"])
async def test_object_requested_byte_budget_includes_integrity_sentinel(retained, boundary):
    identity, _key, body = await retained.historical("budget boundary 🙂" * 200)
    started = await retained.start()
    budget = len(body) + (boundary == "payload_plus_sentinel")
    if boundary == "payload_only":
        for _ in range(3):
            value = await retained.step(started, source_limit=1, byte_budget=budget)
            assert retained.io.reads == []
            assert value["readiness"] != "ready_at_observation"
        assert await indexed_count(retained, identity) == 0
        assert (await retained.status(started))["coverage"]["pending_index"]["count"] == 1
    await retained.finish(started, source_limit=1, byte_budget=len(body) + 1)
    assert await indexed_count(retained, identity) == 1
    assert sum(p["pass"]["requested_bytes"] for p in retained.evidence["passes"]) == len(body) + 1


async def test_service_refuses_byte_budget_above_64_mib_before_io_or_mutation(retained, db_engine):
    identity, _key, body = await retained.historical("strict service budget control")
    started = await retained.start()
    assert (await retained.status(started))["coverage"]["pending_index"]["count"] == 1
    tables = [
        Base.metadata.tables["session_search_backfill_runs"],
        Base.metadata.tables["session_search_backfill_claims"],
        Base.metadata.tables["session_search_states"],
        SessionSearchSource.__table__, SessionSearchChunk.__table__,
        AgentSession.__table__, AgentSessionContent.__table__,
    ]

    async def persisted_state():
        async with retained.factory() as db:
            state = {}
            for table in tables:
                rows = await db.execute(select(table).order_by(*table.primary_key.columns))
                state[table.name] = [dict(row) for row in rows.mappings()]
            return state

    before = await persisted_state()
    statements = []

    def observed_sql(_connection, _cursor, statement, _parameters, _context, _many):
        # Count operations only: no SQL parameters or private identifiers in evidence.
        statements.append(statement.split(None, 1)[0].upper())

    retained.io.clear()
    event.listen(db_engine.sync_engine, "before_cursor_execute", observed_sql)
    try:
        value = receipt(await driver(retained.factory).run_pass(
            run_id(started), source_limit=1, byte_budget=67_108_865,
        ))
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", observed_sql)
    after = await persisted_state()
    retained.evidence["observations"].append({
        "stage": "service_budget_above_64_mib",
        "receipt": value,
        "database_statement_count": len(statements),
        "storage_stat_calls": len(retained.io.stats),
        "storage_read_calls": len(retained.io.reads),
        "persisted_state_unchanged": after == before,
    })
    assert value["result"] == "refused"
    assert value["reason"] == "invalid_limits"
    assert value["exit_code"] == 2
    assert value["run"] is value["progress"] is value["coverage"] is value["verification"] is None
    assert value["readiness"] is None
    assert value["pass"] == {
        "source_limit": 1, "byte_budget": 67_108_865, "sources_attempted": 0,
        "candidate_keys_examined": 0, "reserved_bytes": 0, "requested_bytes": 0,
        "returned_bytes": 0, "stat_calls": 0, "read_calls": 0, "stop_reason": None,
    }
    assert retained.io.reads == retained.io.stats == []
    assert statements == []
    assert after == before

    # The real pending object still indexes through an ordinary valid pass.
    await retained.finish(started, source_limit=1, byte_budget=67_108_864)
    assert await indexed_count(retained, identity) == 1
    assert sum(p["pass"]["requested_bytes"] for p in retained.evidence["passes"]) == len(body) + 1
    assert [item["content_id"] for item in (await retained.find("strict service budget"))["items"]] == [str(identity)]


async def test_descriptor_growth_after_claim_cannot_overrun_pass_budget(retained, monkeypatch):
    identity, _key, body = await retained.historical("descriptor correction " * 200)
    async with retained.factory.begin() as db:
        await db.execute(update(AgentSessionContent).where(AgentSessionContent.id == identity).values(byte_count=16))
    original = SessionSearchObjectProcessor.prepare_source
    reached = []

    async def correct_then_prepare(processor, content_id, **options):
        assert options["max_requested_bytes"] <= 17
        reached.append(content_id)
        async with retained.factory.begin() as db:
            await db.execute(update(AgentSessionContent).where(AgentSessionContent.id == identity).values(byte_count=len(body)))
        return await original(processor, content_id, **options)

    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", correct_then_prepare)
    started = await retained.start()
    for _ in range(4):
        value = await retained.step(started, source_limit=1, byte_budget=17)
        assert retained.io.reads == []
        assert value["readiness"] != "ready_at_observation"
        if reached:
            break
    assert reached == [identity]
    assert await indexed_count(retained, identity) == 0
    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", original)
    await retained.finish(started, source_limit=1, byte_budget=len(body) + 1)
    assert await indexed_count(retained, identity) == 1


async def test_source_limit_and_single_prepared_body_bound_survive_multiple_passes(retained, monkeypatch):
    identities = [(await retained.historical(f"bounded object {i}"))[0] for i in range(3)]
    original_prepare = SessionSearchObjectProcessor.prepare_source
    original_settle = SessionSearchIndexWriter.index_prepared_source
    last_prepared = None
    sequence = []

    async def prepare_one(processor, content_id, **options):
        nonlocal last_prepared
        assert last_prepared is None or last_prepared() is None, "Previous full body remains retained"
        prepared = await original_prepare(processor, content_id, **options)
        last_prepared = weakref.ref(prepared)
        sequence.append(("prepare", content_id))
        return prepared

    async def settle_one(writer, prepared):
        sequence.append(("settle", prepared.content_id))
        return await original_settle(writer, prepared)

    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", prepare_one)
    monkeypatch.setattr(SessionSearchIndexWriter, "index_prepared_source", settle_one)
    started = await retained.start()
    await retained.finish(started, source_limit=1)
    assert len(sequence) == 6
    assert all(sequence[i][0] == "prepare" and sequence[i + 1] == ("settle", sequence[i][1]) for i in range(0, 6, 2))
    assert {entry[1] for entry in sequence} == set(identities)


async def test_reconciliation_finds_lower_uuid_and_late_finalized_content(retained, monkeypatch):
    high_id = uuid.UUID(int=(1 << 128) - 2)
    low_id = uuid.UUID(int=1)
    await retained.historical("high source", identity=high_id)
    late_body = b"late finalized searchable body"
    late_ack = await retained.declare(late_body)
    original = SessionSearchObjectProcessor.prepare_source
    injected = False

    async def commit_late_sources(processor, content_id, **options):
        nonlocal injected
        prepared = await original(processor, content_id, **options)
        if not injected:
            injected = True
            # The worker is suspended here, after its real preparation. These
            # uploads model another producer; post-finalize indexing is paused.
            # Preserve all preceding and resumed worker I/O, including unbounded
            # calls if a worker regression ever introduces one.
            stats_before, reads_before = len(retained.io.stats), len(retained.io.reads)
            try:
                await retained.historical("lower UUID searchable body", identity=low_id)
                assert (await upload(retained.device_client, retained.enrolled, late_ack, late_body))["state"] == "available"
                await retained.db.commit()
            finally:
                producer_reads = retained.io.reads[reads_before:]
                retained.evidence["observations"].append({
                    "stage": "external_producer_during_suspended_preparation",
                    "stat_calls": len(retained.io.stats) - stats_before,
                    "read_calls": len(producer_reads),
                    "unbounded_read_calls": sum(row["requested_bytes"] is None for row in producer_reads),
                    "bounded_requested_bytes": sum(row["requested_bytes"] for row in producer_reads if row["requested_bytes"] is not None),
                    "returned_bytes": sum(row["returned_bytes"] for row in producer_reads),
                })
                del retained.io.stats[stats_before:]
                del retained.io.reads[reads_before:]
        return prepared

    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", commit_late_sources)
    started = await retained.start()
    await retained.finish(started, source_limit=1)
    assert injected
    assert [item["content_id"] for item in (await retained.find("lower UUID"))["items"]] == [str(low_id)]
    assert [item["content_id"] for item in (await retained.find("late finalized"))["items"]] == [late_ack["content_id"]]


async def test_new_epoch_rechecks_restored_same_digest_terminal_unavailable_body(retained):
    identity, key, body = await retained.historical("restored terminal object")
    store = LocalContentStore(settings.LOCAL_STORAGE_DIR)
    store.delete(key)
    prepared = await SessionSearchObjectProcessor(retained.factory).prepare_source(identity)
    assert prepared.outcome == "missing_object"
    async with retained.factory.begin() as db:
        assert await SessionSearchIndexWriter(db).index_prepared_source(prepared) == "unavailable"
    started = await retained.start()
    first = await retained.finish(started)
    assert first["coverage"]["unavailable"]["count"] == 1
    assert first["verification"]["attempted_objects"] == 1
    store.put(key, body)
    assert (await retained.start())["run"]["id"] == started["run"]["id"]
    assert (await retained.find("restored terminal"))["items"] == []
    successor = await retained.start(new_verification_epoch=True)
    assert successor["run"]["id"] != started["run"]["id"]
    final = await retained.finish(successor)
    assert final["verification"]["hash_verified_objects"] == 1
    assert final["coverage"]["unavailable"]["count"] == 0
    assert len((await retained.find("restored terminal"))["items"]) == 1


async def test_newly_missing_object_does_not_reenter_terminal_verification_forever(retained):
    identity, key, _body = await retained.historical("newly missing object")
    LocalContentStore(settings.LOCAL_STORAGE_DIR).delete(key)
    started = await retained.start()
    finished = await retained.finish(started, source_limit=1)
    assert finished["coverage"]["unavailable"]["count"] == 1
    assert finished["coverage"]["index_ready"] is True
    assert sum(row["pass"]["stat_calls"] for row in retained.evidence["passes"]) == 1
    assert sum(row["pass"]["read_calls"] for row in retained.evidence["passes"]) == 0
    assert await indexed_count(retained, identity) == 0


@pytest.mark.parametrize("change", ["delete", "revoke"])
async def test_source_loss_after_preparation_cannot_write_private_index(retained, monkeypatch, change):
    identity, _key, _body = await retained.historical("source lost after preparation")
    original = SessionSearchObjectProcessor.prepare_source
    reached = []

    async def prepare_then_lose_access(processor, content_id, **options):
        prepared = await original(processor, content_id, **options)
        assert prepared.outcome == "ready"
        reached.append(content_id)
        async with retained.factory.begin() as db:
            if change == "delete":
                await db.execute(delete(AgentSession).where(AgentSession.id == retained.session_id))
            else:
                await db.execute(delete(WorkspaceMember).where(
                    WorkspaceMember.workspace_id == retained.workspace.id,
                    WorkspaceMember.user_id == retained.owner.id,
                ))
        return prepared

    monkeypatch.setattr(SessionSearchObjectProcessor, "prepare_source", prepare_then_lose_access)
    started = await retained.start()
    await retained.finish(started)
    assert reached == [identity]
    assert await indexed_count(retained, identity) == 0
    async with retained.factory.begin() as db:
        assert await db.scalar(select(func.count()).select_from(SessionSearchChunk)) == 0
        if change == "delete":
            assert await db.get(AgentSessionContent, identity) is None
    denied = await retained.client.post(f"{retained.path}/search", json={"q": "source lost"})
    assert denied.status_code == (404 if change == "delete" else 403)
    assert "source lost after preparation" not in denied.text


async def test_owner_removed_before_discovery_gets_no_body_read_and_explicit_exclusion(retained):
    identity, _key, _body = await retained.historical("unauthorized retained object")
    async with retained.factory.begin() as db:
        await db.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == retained.workspace.id,
            WorkspaceMember.user_id == retained.owner.id,
        ))
    started = await retained.start()
    finished = await retained.finish(started)
    assert finished["coverage"]["owner_not_member_count"] == 1
    assert all(row["pass"]["read_calls"] == row["pass"]["stat_calls"] == 0 for row in retained.evidence["passes"])
    assert await indexed_count(retained, identity) == 0


async def test_candidate_bound_precedes_membership_filter_for_250_retained_identities(retained):
    identity, _key, body = await retained.historical(
        "candidate scan control", identity=uuid.UUID(int=1)
    )
    control = await retained.client.get(f"{retained.path}/contents/{identity}/body")
    assert control.status_code == 200
    assert control.json()["text"].encode() == body
    await retained.db.commit()
    async with retained.factory.begin() as db:
        template = await db.get(AgentSessionContent, identity)
        values = {
            column.name: getattr(template, column.name)
            for column in AgentSessionContent.__table__.columns
        }
        for ordinal in range(2, 251):
            source_id = uuid.UUID(int=ordinal)
            db.add(AgentSessionContent(**{
                **values,
                "id": source_id,
                "content_key": hashlib.sha256(source_id.bytes).hexdigest(),
                "source_order": ordinal,
            }))
        await db.execute(update(AgentSession).where(AgentSession.id == retained.session_id).values(
            content_count=250, content_bytes=250 * len(body)
        ))
        await db.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == retained.workspace.id,
            WorkspaceMember.user_id == retained.owner.id,
        ))
    started = await retained.start()
    for _ in range(4):
        first = await retained.step(started)
        assert retained.io.reads == retained.io.stats == []
        if first["pass"]["candidate_keys_examined"]:
            break
    assert first["pass"]["candidate_keys_examined"] == 200
    assert first["progress"]["discovery_complete"] is False
    finished = await retained.finish(started)
    assert finished["coverage"]["owner_not_member_count"] == 250
    assert all(row["pass"]["read_calls"] == row["pass"]["stat_calls"] == 0 for row in retained.evidence["passes"])
    assert sum(row["pass"]["candidate_keys_examined"] for row in retained.evidence["passes"]) >= 250


async def test_storage_retry_backoff_and_five_attempt_exhaustion_survive_restart(retained):
    identity, _key, body = await retained.historical("retry-persisted object")
    started = await retained.start()
    retained.io.fail_reads = True
    table = Base.metadata.tables["session_search_backfill_claims"]
    for attempt in range(1, 6):
        for _ in range(4):
            value = await retained.step(started, source_limit=1, byte_budget=len(body) + 1)
            rows = await claims(retained, started)
            if rows and rows[0]["attempts"] == attempt:
                break
        [claim] = rows
        assert claim["source_id"] == identity
        assert claim["attempts"] == attempt
        assert value["readiness"] != "ready_at_observation"
        assert value["pass"]["requested_bytes"] == len(body) + 1
        assert await indexed_count(retained, identity) == 0
        if attempt < 5:
            assert claim["state"] == "retry_wait"
            assert claim["next_attempt_at"] is not None
            paused = await retained.step(started)
            assert paused["exit_code"] == 12
            assert retained.io.reads == retained.io.stats == []
            async with retained.factory.begin() as db:
                now = await db.scalar(select(func.current_timestamp()))
                await db.execute(update(table).where(table.c.run_id == run_id(started)).values(
                    next_attempt_at=now - timedelta(minutes=1)
                ))
    assert claim["state"] == "exhausted"
    assert (await retained.status(started))["progress"]["claims"]["exhausted"] == 1
    for _ in range(4):
        final = await retained.step(started)
        assert retained.io.reads == retained.io.stats == []
        if final["readiness"] == "exhausted_unready":
            break
    assert final["readiness"] == "exhausted_unready"
    assert final["exit_code"] == 13
    assert (await claims(retained, started))[0]["attempts"] == 5


async def test_unknown_legacy_size_remains_unready_with_unknown_bytes(retained):
    identity, _key, _body = await retained.historical("unknown historical byte count")
    async with retained.factory.begin() as db:
        await db.execute(update(AgentSessionContent).where(AgentSessionContent.id == identity).values(byte_count=None))
    started = await retained.start()
    for _ in range(6):
        value = await retained.step(started)
        assert retained.io.reads == []
        assert value["readiness"] != "ready_at_observation"
        if value["readiness"] == "exhausted_unready":
            break
    assert value["coverage"]["pending_index"] == {"count": 1, "bytes": None}
    assert value["readiness"] == "exhausted_unready"
    assert value["progress"]["outcomes"]["invalid_metadata"] >= 1


async def test_store_drift_refuses_pass_without_touching_claims_or_bodies(retained, monkeypatch, tmp_path):
    await retained.historical("configuration binding object")
    started = await retained.start()
    before = await claims(retained, started)
    monkeypatch.setattr(settings, "LOCAL_STORAGE_DIR", str(tmp_path / "different-effective-store"))
    value = await retained.step(started)
    assert value["reason"] == "configuration_mismatch"
    assert value["exit_code"] == 3
    assert value["readiness"] is None
    assert retained.io.reads == retained.io.stats == []
    assert await claims(retained, started) == before
    assert (await retained.status(started))["readiness"] is None
