# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Relationship refreshes observed across real PostgreSQL transactions."""

import asyncio

import pytest
from sqlalchemy import delete, event, select

from app.core.event_bus import event_bus
from app.models.agent_session import (
    AgentSession,
    AgentSessionInvocation,
    SessionWorkLink,
)
from app.models.mcp_invocation import MCPConsultation, MCPInvocation
from app.models.notes.note import Note
from app.schemas.mcp_invocation import MCPInvocationCreate
from app.services.mcp_invocation import MCPInvocationService
from app.services.agent_session_ingest import AgentSessionIngestService, _Rejected
from tests.test_session_content_postgres import (
    pg as capture_postgres_fixture,
    post_batch,
)
from tests.test_session_correlation import ARGS, pi_outcome, pi_record, pi_tool_event

pytestmark = pytest.mark.slow
pg = capture_postgres_fixture


@pytest.fixture
async def relationship(pg):
    calls = [f"toolu_transaction_{index}" for index in range(3)]
    result = await post_batch(
        pg,
        [
            pi_record(
                [
                    pi_tool_event("valaris_get_card", ARGS, call_id=call)
                    for call in calls
                ],
                str(pg["mapping_id"]),
            )
        ],
    )
    assert result["rejected"] == []
    outcomes = [
        MCPInvocationCreate.model_validate(
            pi_outcome(
                workspace_slug=pg["slug"],
                native_call_id=call,
                arguments_fingerprint=None,
            )
        )
        for call in calls
    ]
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(
                AgentSession.workspace_id == pg["workspace_id"]
            )
        )
        note = Note(
            workspace_id=pg["workspace_id"],
            created_by=pg["owner_id"],
            title="Synthetic consultation target",
        )
        db.add(note)
        await db.flush()
        db.add_all(
            MCPConsultation(
                invocation_id=outcome.id,
                actor_id=pg["owner_id"],
                principal_key="",
                workspace_id=pg["workspace_id"],
                entity_type="note",
                entity_id=note.id,
            )
            for outcome in outcomes
        )
    return {**pg, "session_id": session_id, "outcomes": outcomes}


async def durable_relationship(relationship):
    async with relationship["factory"]() as observer:
        matched = set(
            await observer.scalars(
                select(AgentSessionInvocation.invocation_id).where(
                    AgentSessionInvocation.session_id == relationship["session_id"]
                )
            )
        )
        counts = list(
            await observer.scalars(
                select(SessionWorkLink.invocation_count).where(
                    SessionWorkLink.session_id == relationship["session_id"]
                )
            )
        )
        return matched, counts


@pytest.fixture
async def refreshes(relationship):
    observed = []
    received = asyncio.Event()

    async def receive(event):
        observed.append((event, await durable_relationship(relationship)))
        received.set()

    unsubscribe = event_bus.subscribe(
        receive,
        workspace_id=relationship["workspace_id"],
        event_pattern="agent_session.updated",
    )
    try:
        yield observed, received
    finally:
        unsubscribe()


async def published(refreshes):
    observed, received = refreshes
    try:
        await asyncio.wait_for(received.wait(), timeout=1)
    except TimeoutError:
        pytest.fail("Committed relationship did not refresh the owner's session")
    await asyncio.sleep(0.01)
    return observed


async def record(relationship, db, index=0):
    return await MCPInvocationService(db).record(
        relationship["owner_id"], relationship["outcomes"][index]
    )


async def test_postgres_refresh_subscriber_reads_committed_relationship(
    relationship, refreshes
):
    async with relationship["factory"]() as db:
        await record(relationship, db)
        assert await durable_relationship(relationship) == (set(), [])
        await asyncio.sleep(0.01)
        assert refreshes[0] == []
        await db.commit()

    [(event, visible)] = await published(refreshes)
    assert visible == ({relationship["outcomes"][0].id}, [1])
    assert event.payload["session_id"] == str(relationship["session_id"])
    assert event.payload["owner_id"] == str(relationship["owner_id"])


async def test_postgres_match_refreshes_even_when_its_target_was_deleted(
    relationship, refreshes
):
    async with relationship["factory"].begin() as db:
        await db.execute(
            delete(Note).where(Note.workspace_id == relationship["workspace_id"])
        )
    async with relationship["factory"].begin() as db:
        await record(relationship, db)
    assert await durable_relationship(relationship) == (
        {relationship["outcomes"][0].id},
        [],
    )
    [(event, visible)] = await published(refreshes)
    assert visible == ({relationship["outcomes"][0].id}, [])
    assert event.payload["session_id"] == str(relationship["session_id"])


@pytest.mark.parametrize("savepoint", [False, True])
async def test_postgres_rolled_back_relationship_never_refreshes(
    relationship, refreshes, savepoint
):
    async with relationship["factory"]() as db:
        if savepoint:
            await db.begin()
            boundary = await db.begin_nested()
        else:
            boundary = await db.begin()
        await record(relationship, db)
        await boundary.rollback()
        await db.commit()
    await asyncio.sleep(0.01)
    assert await durable_relationship(relationship) == (set(), [])
    assert refreshes[0] == []
    async with relationship["factory"]() as observer:
        assert await observer.get(MCPInvocation, relationship["outcomes"][0].id) is None


async def test_postgres_savepoint_release_waits_for_outer_commit(
    relationship, refreshes
):
    async with relationship["factory"].begin() as db:
        async with db.begin_nested():
            await record(relationship, db)
        assert await durable_relationship(relationship) == (set(), [])
        await asyncio.sleep(0.01)
        assert refreshes[0] == []
    [(_, visible)] = await published(refreshes)
    assert visible == ({relationship["outcomes"][0].id}, [1])


@pytest.mark.parametrize("discard_first", [False, True])
async def test_postgres_savepoint_rollback_preserves_and_deduplicates_surviving_refreshes(
    relationship, refreshes, discard_first
):
    async with relationship["factory"].begin() as db:
        if not discard_first:
            await record(relationship, db, 0)
        discarded = await db.begin_nested()
        await record(relationship, db, 1)
        await discarded.rollback()
        if discard_first:
            await record(relationship, db, 0)
        async with db.begin_nested():
            await record(relationship, db, 2)
        await record(relationship, db, 2)
        await asyncio.sleep(0.01)
        assert refreshes[0] == []

    [(_, visible)] = await published(refreshes)
    assert visible == (
        {relationship["outcomes"][index].id for index in (0, 2)},
        [2],
    )
    async with relationship["factory"].begin() as db:
        await record(relationship, db, 0)
        await record(relationship, db, 2)
    await asyncio.sleep(0.01)
    assert len(refreshes[0]) == 1, "Authorized no-op retries replayed refreshes"


async def test_postgres_concurrent_duplicate_receipts_emit_one_refresh(
    relationship, refreshes
):
    async def receipt():
        async with relationship["factory"].begin() as db:
            return (await record(relationship, db)).id

    invocation_id = relationship["outcomes"][0].id
    assert (
        await asyncio.wait_for(asyncio.gather(*(receipt() for _ in range(4))), 5)
        == [invocation_id] * 4
    )
    [(_, visible)] = await published(refreshes)
    assert visible == ({invocation_id}, [1])


async def test_postgres_rollback_then_retry_on_reused_session_refreshes_once(
    relationship, refreshes
):
    async with relationship["factory"]() as db:
        await record(relationship, db)
        await db.rollback()
        assert await durable_relationship(relationship) == (set(), [])
        assert refreshes[0] == []
        await record(relationship, db)
        await db.commit()
    [(_, visible)] = await published(refreshes)
    assert visible == ({relationship["outcomes"][0].id}, [1])


async def test_postgres_failed_commit_does_not_refresh(relationship, refreshes):
    class CommitRejected(Exception):
        pass

    def reject_commit(_session):
        raise CommitRejected("Synthetic failed commit")

    async with relationship["factory"]() as db:
        await record(relationship, db)
        event.listen(db.sync_session, "before_commit", reject_commit)
        try:
            with pytest.raises(CommitRejected):
                await db.commit()
        finally:
            event.remove(db.sync_session, "before_commit", reject_commit)
            await db.rollback()
    await asyncio.sleep(0.01)
    assert await durable_relationship(relationship) == (set(), [])
    assert refreshes[0] == []


async def test_postgres_rejected_capture_does_not_announce_rolled_back_retraction(
    relationship, refreshes, monkeypatch
):
    async with relationship["factory"].begin() as db:
        await record(relationship, db)
    await asyncio.sleep(0.01)
    refreshes[0].clear()
    original = AgentSessionIngestService._ingest_record

    async def reject_after_relationship_change(self, *args, **kwargs):
        await original(self, *args, **kwargs)
        assert not list(
            await self.db.scalars(
                select(SessionWorkLink.id).where(
                    SessionWorkLink.session_id == relationship["session_id"]
                )
            )
        )
        raise _Rejected("conflict")

    monkeypatch.setattr(
        AgentSessionIngestService, "_ingest_record", reject_after_relationship_change
    )
    result = await post_batch(
        relationship,
        [
            pi_record(
                [
                    pi_tool_event(
                        "valaris_get_card",
                        ARGS,
                        call_id=relationship["outcomes"][0].native_call_id,
                        session="rejected-second-candidate",
                    )
                ],
                str(relationship["mapping_id"]),
                session="rejected-second-candidate",
            )
        ],
    )
    assert [item["reason"] for item in result["rejected"]] == ["conflict"]
    assert await durable_relationship(relationship) == (
        {relationship["outcomes"][0].id},
        [1],
    )
    await asyncio.sleep(0.01)
    assert refreshes[0] == [], "A rejected capture announced a rolled-back retraction"


async def test_postgres_concurrent_capture_and_receipt_refresh_durable_match(pg):
    native_session = "concurrent-arrival"
    native_call = "toolu_concurrent_arrival"
    outcome = MCPInvocationCreate.model_validate(
        pi_outcome(
            workspace_slug=pg["slug"],
            native_call_id=native_call,
            arguments_fingerprint=None,
        )
    )
    async with pg["factory"].begin() as db:
        note = Note(
            workspace_id=pg["workspace_id"],
            created_by=pg["owner_id"],
            title="Concurrent consultation",
        )
        db.add(note)
        await db.flush()
        db.add(
            MCPConsultation(
                invocation_id=outcome.id,
                actor_id=pg["owner_id"],
                principal_key="",
                workspace_id=pg["workspace_id"],
                entity_type="note",
                entity_id=note.id,
            )
        )
    matched_on_refresh = []
    received_match = asyncio.Event()

    async def receive(event):
        async with pg["factory"]() as observer:
            matched = await observer.scalar(
                select(AgentSessionInvocation.session_id).where(
                    AgentSessionInvocation.invocation_id == outcome.id
                )
            )
            count = await observer.scalar(
                select(SessionWorkLink.invocation_count).where(
                    SessionWorkLink.session_id == matched,
                    SessionWorkLink.entity_id == note.id,
                )
            )
        matched_on_refresh.append((event.payload.get("session_id"), matched, count))
        if matched is not None and count == 1:
            received_match.set()

    unsubscribe = event_bus.subscribe(
        receive, workspace_id=pg["workspace_id"], event_pattern="agent_session.updated"
    )
    try:

        async def receipt():
            async with pg["factory"].begin() as db:
                await MCPInvocationService(db).record(pg["owner_id"], outcome)

        async def capture():
            result = await post_batch(
                pg,
                [
                    pi_record(
                        [
                            pi_tool_event(
                                "valaris_get_card",
                                ARGS,
                                call_id=native_call,
                                session=native_session,
                            )
                        ],
                        str(pg["mapping_id"]),
                        session=native_session,
                    )
                ],
            )
            assert result["rejected"] == []

        await asyncio.wait_for(asyncio.gather(receipt(), capture()), 5)
        try:
            await asyncio.wait_for(received_match.wait(), 1)
        except TimeoutError:
            pytest.fail(
                f"No refresh observed the concurrent durable match: {matched_on_refresh}"
            )
        assert any(
            session_id == str(matched) and count == 1
            for session_id, matched, count in matched_on_refresh
        )
    finally:
        unsubscribe()
