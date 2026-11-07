# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B01H's requested-byte fence at the existing object preparer.

The baseline has no budget argument. The compatibility helper deliberately
calls its original signature so the red measures real storage I/O, not a
TypeError. Once the optional argument exists, the same cases exercise it.
"""

import hashlib
import inspect
import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.agent_session import AgentSessionContent
from app.models.session_search import SessionSearchSource
from app.repositories.session_search import SessionSearchRepository
from app.services import session_search_index
from app.services.session_search_index import SessionSearchObjectProcessor
from app.services.storage.session_content import ContentObject
from tests.rich_capture import declaration, upload
from tests.test_session_search import (
    capture as capture_fixture,
    paused_object_indexing as paused_object_indexing_fixture,
    store_contents,
)

capture = capture_fixture
paused_object_indexing = paused_object_indexing_fixture
pytestmark = [
    pytest.mark.slow,
    pytest.mark.usefixtures("content_storage", "paused_object_indexing"),
]

PAYLOAD = ("Budget control: Straße 🙂\n" * 128).encode()


class CountingBoundedStore:
    backend = "local"

    def __init__(self, key, body, receipt):
        self.key = key
        self.body = body
        self.receipt = receipt

    def stat(self, key):
        assert key == self.key
        self.receipt["stats"].append({"size": len(self.body)})
        return ContentObject(key, len(self.body), datetime.now(timezone.utc))

    def read(self, key, offset=0, length=None):
        assert key == self.key
        returned = self.body[offset:] if length is None else self.body[offset : offset + length]
        self.receipt["reads"].append(
            {"offset": offset, "requested_bytes": length, "returned_bytes": len(returned)}
        )
        return returned


@pytest.fixture
async def object_case(
    device_client, capture, db_session, db_engine, monkeypatch, tmp_path, request
):
    [ack] = await store_contents(
        device_client, capture, [declaration(PAYLOAD, delivery="upload")]
    )
    assert ack["outcome"] == "upload_required"
    assert (await upload(device_client, capture, ack, PAYLOAD))["state"] == "available"
    content_id = uuid.UUID(ack["content_id"])
    assert await db_session.scalar(
        select(SessionSearchSource.status).where(
            SessionSearchSource.content_id == content_id
        )
    ) == "pending"
    await db_session.commit()
    factory = async_sessionmaker(db_engine, expire_on_commit=False)
    async with factory.begin() as db:
        descriptor = await SessionSearchRepository(db).object_descriptor(content_id)
    assert descriptor.inline_text is None
    assert descriptor.byte_count == len(PAYLOAD)
    assert descriptor.sha256 == hashlib.sha256(PAYLOAD).hexdigest()
    receipt = {
        "test": request.node.name,
        "test_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "production_sha256": hashlib.sha256(
            Path(session_search_index.__file__).read_bytes()
        ).hexdigest(),
        "payload_bytes": len(PAYLOAD),
        "stats": [],
        "reads": [],
    }
    store = CountingBoundedStore(descriptor.storage_key, PAYLOAD, receipt)

    def counted_store(backend):
        assert backend == store.backend
        return store

    monkeypatch.setattr(session_search_index, "store_for", counted_store)
    try:
        yield factory, descriptor, receipt
    finally:
        receipt["stat_calls"] = len(receipt["stats"])
        receipt["read_calls"] = len(receipt["reads"])
        receipt["requested_bytes"] = sum(
            item["requested_bytes"] or 0 for item in receipt["reads"]
        )
        receipt["returned_bytes"] = sum(
            item["returned_bytes"] for item in receipt["reads"]
        )
        (tmp_path / "preparer-budget-receipt.json").write_text(
            json.dumps(receipt, indent=2) + "\n"
        )


async def prepare_with_budget(factory, descriptor, receipt, budget):
    processor = SessionSearchObjectProcessor(factory)
    supports_budget = "max_requested_bytes" in inspect.signature(
        processor.prepare_source
    ).parameters
    receipt["budget_parameter_supported"] = supports_budget
    receipt["reserved_requested_bytes"] = budget
    options = {"max_requested_bytes": budget} if supports_budget else {}
    prepared = await processor.prepare_source(
        descriptor.content_id, expected_digest=descriptor.sha256, **options
    )
    receipt["preparation_outcome"] = prepared.outcome
    receipt["reloaded_descriptor_bytes"] = prepared.descriptor.byte_count
    receipt["chunk_count"] = len(prepared.chunks)
    return prepared


def assert_budget_deferred(prepared, receipt, budget):
    assert all(item["requested_bytes"] is not None for item in receipt["reads"])
    requested = sum(item["requested_bytes"] for item in receipt["reads"])
    assert requested <= budget, (
        f"preparer requested {requested} storage bytes with only {budget} reserved; "
        f"stat calls={len(receipt['stats'])}, reads={receipt['reads']}, "
        f"outcome={prepared.outcome}"
    )
    assert receipt["reads"] == [], "An object that cannot fit must not be partly read"
    assert prepared.outcome == "budget_deferred"
    assert prepared.chunks == ()


def assert_complete_body_and_sentinel(prepared, receipt):
    assert prepared.outcome == "ready"
    [chunk] = prepared.chunks
    assert chunk.text.original.encode() == PAYLOAD
    assert chunk.segment_byte_start == 0
    assert chunk.segment_byte_end == len(PAYLOAD)
    assert receipt["stats"] == [{"size": len(PAYLOAD)}]
    assert receipt["reads"] == [
        {"offset": 0, "requested_bytes": len(PAYLOAD) + 1, "returned_bytes": len(PAYLOAD)}
    ]


async def test_prepare_rechecks_same_digest_size_correction_against_reserved_budget(
    object_case,
):
    factory, descriptor, receipt = object_case
    # A metadata reservation and the preparer's later lookup are separate
    # committed observations. Correcting the size need not change the digest.
    async with factory.begin() as db:
        await db.execute(
            update(AgentSessionContent)
            .where(AgentSessionContent.id == descriptor.content_id)
            .values(byte_count=32)
        )
    async with factory.begin() as db:
        reserved = await SessionSearchRepository(db).object_descriptor(descriptor.content_id)
    assert reserved.byte_count == 32
    assert reserved.sha256 == descriptor.sha256
    budget = reserved.byte_count + 1
    receipt["reservation_descriptor_bytes"] = reserved.byte_count
    async with factory.begin() as db:
        await db.execute(
            update(AgentSessionContent)
            .where(AgentSessionContent.id == descriptor.content_id)
            .values(byte_count=len(PAYLOAD))
        )
    prepared = await prepare_with_budget(factory, reserved, receipt, budget)
    assert prepared.descriptor.byte_count == len(PAYLOAD)
    assert prepared.descriptor.sha256 == reserved.sha256
    assert_budget_deferred(prepared, receipt, budget)


async def test_prepare_counts_integrity_sentinel_in_requested_byte_budget(object_case):
    factory, descriptor, receipt = object_case
    budget = len(PAYLOAD)
    prepared = await prepare_with_budget(factory, descriptor, receipt, budget)
    assert_budget_deferred(prepared, receipt, budget)


async def test_prepare_exact_payload_plus_sentinel_budget_preserves_complete_body(object_case):
    factory, descriptor, receipt = object_case
    prepared = await prepare_with_budget(factory, descriptor, receipt, len(PAYLOAD) + 1)
    assert_complete_body_and_sentinel(prepared, receipt)


async def test_prepare_ordinary_caller_without_budget_preserves_complete_body(object_case):
    factory, descriptor, receipt = object_case
    receipt["reserved_requested_bytes"] = None
    prepared = await SessionSearchObjectProcessor(factory).prepare_source(
        descriptor.content_id, expected_digest=descriptor.sha256
    )
    receipt["preparation_outcome"] = prepared.outcome
    receipt["chunk_count"] = len(prepared.chunks)
    assert_complete_body_and_sentinel(prepared, receipt)


async def test_settle_budget_deferred_preserves_pending_index_and_generation(object_case):
    from app.models.session_search import SessionSearchChunk, SessionSearchState
    from app.services.session_search_index import PreparedSource, SessionSearchIndexWriter

    factory, descriptor, receipt = object_case

    async def index_snapshot():
        snapshot = {}
        async with factory.begin() as db:
            for name, model in (
                ("sources", SessionSearchSource),
                ("chunks", SessionSearchChunk),
                ("generations", SessionSearchState),
            ):
                rows = await db.execute(
                    select(model.__table__).where(model.session_id == descriptor.session_id)
                )
                snapshot[name] = [
                    {key: None if value is None else str(value) for key, value in row.items()}
                    for row in rows.mappings()
                ]
        return snapshot

    before = await index_snapshot()
    [pending] = before["sources"]
    assert pending["content_id"] == str(descriptor.content_id)
    assert pending["status"] == "pending"
    assert pending["chunk_count"] == "0"
    assert before["chunks"] == []
    receipt["before_settlement"] = before
    # Root's new preparation outcome can already be represented by this
    # runtime dataclass; the baseline preparer does not yet produce it.
    prepared = PreparedSource(descriptor.content_id, "budget_deferred", descriptor)
    try:
        async with factory.begin() as db:
            result = await SessionSearchIndexWriter(db).index_prepared_source(prepared)
            receipt["settlement_result"] = result
            assert db.in_transaction(), "The writer must leave the commit to its caller"
    except Exception as error:
        receipt["settlement_exception"] = type(error).__name__
        raise
    finally:
        after = await index_snapshot()
        receipt["after_settlement"] = after
        receipt["settlement_preserved_index"] = after == before
        assert after == before
        assert receipt["stats"] == []
        assert receipt["reads"] == []
    assert result == "pending"
