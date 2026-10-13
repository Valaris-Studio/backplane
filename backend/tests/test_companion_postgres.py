# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Run only against a disposable PostgreSQL database migrated to 109 or later.

SESSION_CAPTURE_TEST_DATABASE_URL enables the real transaction, row-lock and
JSONB seams. The tests create synthetic users/workspaces and delete only those.
"""

import asyncio
import copy
import json
import os
import time
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.mcp_invocation import current_mcp_invocation_id
from app.database import build_engine, get_db
from app.main import create_app
from app.models.activity import ActivityAction, ActivityEntityType
from app.models.agent_session import AgentSession, AgentSessionEvent, SessionWorkLink
from app.models.api_key import ApiKey
from app.models.companion import CompanionInstallation, CompanionProjectMapping
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.companion import CompanionRepository
from app.schemas.companion import InstallationCreate, MappingCreate
from app.schemas.mcp_invocation import MCPInvocationCreate
from app.services.activity import ActivityService
from app.services.agent_session import (
    AgentSessionService,
    recount_next_session_activity,
)
from app.services.api_key import ApiKeyService
from app.services.companion import CompanionService
from app.services.mcp_invocation import MCPInvocationService
from app.services.session_calls import SessionCallService
from app.services.session_rhythm import SessionRhythmService

FIXTURE_EVENTS = [
    event
    for record in json.loads(
        (
            Path(__file__).parent / "fixtures/session_capture/beacon_hooks.json"
        ).read_text()
    )
    for event in record["beacon_events"]
]
pytestmark = pytest.mark.slow


@pytest.fixture
async def pg():
    url = os.environ.get("SESSION_CAPTURE_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires explicit disposable migrated PostgreSQL database")
    engine = create_async_engine(url, hide_parameters=True)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    owner_id, workspace_id = uuid.uuid4(), uuid.uuid4()
    board_id, column_id, card_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    slug = "capture-test-" + workspace_id.hex
    async with factory.begin() as db:
        assert await db.scalar(text("select version_num from alembic_version")) >= "109"
        db.add(User(id=owner_id, email=slug + "@example.test", name="Synthetic owner"))
        await db.flush()
        db.add(
            Workspace(id=workspace_id, name="Synthetic", slug=slug, created_by=owner_id)
        )
        await db.flush()
        db.add(
            WorkspaceMember(
                workspace_id=workspace_id, user_id=owner_id, role=WorkspaceRole.owner
            )
        )
        db.add(
            Board(
                id=board_id,
                workspace_id=workspace_id,
                name="Synthetic board",
                slug="synthetic",
                created_by=owner_id,
            )
        )
        await db.flush()
        db.add(Column(id=column_id, board_id=board_id, name="Todo", position=1024))
        await db.flush()
        db.add(
            Card(
                id=card_id,
                board_id=board_id,
                column_id=column_id,
                title="Synthetic card",
                position=1024,
                created_by=owner_id,
            )
        )
        enrollment, _ = await CompanionService(db).enroll(
            owner_id,
            InstallationCreate(
                installation_id=uuid.uuid4(), name="Synthetic", platform="linux"
            ),
        )
        mapping, _ = await CompanionService(db).create_mapping(
            owner_id,
            enrollment.installation_id,
            MappingCreate(
                workspace_id=workspace_id,
                board_id=board_id,
                root_path="/synthetic/project",
                # Written against standard; new mappings now default to rich.
                content_level="standard",
            ),
        )
    app = create_app()

    async def request_transaction():
        async with factory.begin() as db:
            yield db

    app.dependency_overrides[get_db] = request_transaction
    client = AsyncClient(transport=ASGITransport(app), base_url="http://test")
    try:
        yield {
            "factory": factory,
            "client": client,
            "url": url,
            "owner_id": owner_id,
            "workspace_id": workspace_id,
            "board_id": board_id,
            "card_id": card_id,
            "mapping_id": mapping.id,
            "headers": {"Authorization": "Bearer " + enrollment.device_token},
        }
    finally:
        await client.aclose()
        async with factory.begin() as db:
            await db.execute(delete(Workspace).where(Workspace.id == workspace_id))
            await db.execute(delete(User).where(User.id == owner_id))
        await engine.dispose()


def record(env, events, **overrides):
    return {
        "capture_id": uuid.uuid4().hex,
        "mapping_id": str(env["mapping_id"]),
        "harness": "claude_code",
        "collection_method": "hook",
        "native_session_id": "sc01-synthetic-session",
        "captured_at": "2026-09-24T02:21:30Z",
        "beacon": {"commit": "b" * 40, "schema_version": "1.0"},
        "events": events,
        **overrides,
    }


async def post_batch(env, records):
    response = await env["client"].post(
        "/api/companion/ingest", json={"records": records}, headers=env["headers"]
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_concurrent_uploads_store_each_event_once_with_exact_summary(pg):
    records = [record(pg, [event]) for event in FIXTURE_EVENTS]
    otlp_copies = []
    for event in FIXTURE_EVENTS:
        otlp = copy.deepcopy(event)
        otlp["harness"]["collection_method"] = "otlp"
        otlp_copies.append(record(pg, [otlp], collection_method="otlp"))

    results = await asyncio.wait_for(
        asyncio.gather(
            *(post_batch(pg, records) for _ in range(4)),
            *(post_batch(pg, otlp_copies) for _ in range(2)),
        ),
        30,
    )
    for result in results:
        assert result["rejected"] == []
    async with pg["factory"].begin() as db:
        session = await db.scalar(
            select(AgentSession).where(AgentSession.owner_id == pg["owner_id"])
        )
        assert session.event_count == 7
        assert session.prompt_count == 1
        assert session.tool_call_count == 2
        assert session.error_count == 1
        # Everything but the start and end markers is activity, counted once
        # however the uploads raced.
        assert session.activity_event_count == 5
        assert session.capture_levels == ["standard"]
        assert session.status == "ended"
        assert session.cost_usd is None
        stored = await db.scalar(
            select(func.count())
            .select_from(AgentSessionEvent)
            .where(AgentSessionEvent.session_id == session.id)
        )
        assert stored == 7
        # JSONB round trip keeps the uploaded document.
        prompt = await db.scalar(
            select(AgentSessionEvent.event).where(
                AgentSessionEvent.session_id == session.id,
                AgentSessionEvent.action == "prompt.submitted",
            )
        )
        assert prompt["prompt"]["text"] == FIXTURE_EVENTS[1]["prompt"]["text"]
        column_type = await db.scalar(
            text(
                "select data_type from information_schema.columns "
                "where table_name = 'agent_session_events' and column_name = 'event'"
            )
        )
        assert column_type == "jsonb"


async def test_levels_and_activity_counts_hold_across_level_changes_and_old_rows(pg):
    async def set_level(level):
        async with pg["factory"].begin() as db:
            await db.execute(
                update(CompanionProjectMapping)
                .where(CompanionProjectMapping.id == pg["mapping_id"])
                .values(content_level=level)
            )

    await set_level("metadata")
    await post_batch(pg, [record(pg, FIXTURE_EVENTS[:2])])
    await set_level("standard")
    await post_batch(pg, [record(pg, FIXTURE_EVENTS[2:4])])
    async with pg["factory"].begin() as db:
        session = await db.scalar(
            select(AgentSession).where(AgentSession.owner_id == pg["owner_id"])
        )
        assert session.capture_levels == ["metadata", "standard"]
        assert session.activity_event_count == 3
        # A row as the previous release leaves it: no count.
        session.activity_event_count = None
    recounted, after = [], None
    while True:
        async with pg["factory"].begin() as db:
            after = await recount_next_session_activity(db, after)
        if after is None:
            break
        recounted.append(after)
    assert session.id in recounted
    async with pg["factory"].begin() as db:
        assert (
            await db.scalar(
                select(AgentSession.activity_event_count).where(
                    AgentSession.id == session.id
                )
            )
            == 3
        )


async def test_conflicting_capture_retry_is_rejected_per_record(pg):
    first = record(pg, FIXTURE_EVENTS[:1])
    assert (await post_batch(pg, [first]))["acknowledged"] == [first["capture_id"]]
    changed = {**first, "events": FIXTURE_EVENTS[1:2]}
    fresh = record(pg, FIXTURE_EVENTS[2:3])
    result = await post_batch(pg, [changed, fresh])
    assert result == {
        "acknowledged": [fresh["capture_id"]],
        "rejected": [{"capture_id": first["capture_id"], "reason": "conflict"}],
        "dropped": [],
        "history_deleted": [],
        "contents": [],
    }


@pytest.mark.parametrize("invocation_first", [False, True])
async def test_concurrent_sides_materialize_one_link(pg, invocation_first):
    invocation_id = uuid.uuid4()
    async with pg["factory"].begin() as db:
        token = current_mcp_invocation_id.set(invocation_id)
        try:
            await ActivityService(db).record(
                workspace_id=pg["workspace_id"],
                actor_id=pg["owner_id"],
                entity_type=ActivityEntityType.card,
                entity_id=pg["card_id"],
                action=ActivityAction.updated,
                board_id=pg["board_id"],
                summary="synthetic change",
            )
        finally:
            current_mcp_invocation_id.reset(token)
    start = FIXTURE_EVENTS[0]["timestamp"]
    outcome = MCPInvocationCreate(
        id=invocation_id,
        tool_name="update_card",
        status="completed",
        started_at=start,
        completed_at=start,
        duration_seconds=0,
        harness="claude_code",
        native_call_id="toolu_evidence_1",
    )

    async def record_invocation():
        async with pg["factory"].begin() as db:
            await MCPInvocationService(db).record(pg["owner_id"], outcome)

    uploads = post_batch(pg, [record(pg, FIXTURE_EVENTS)])
    sides = [record_invocation(), uploads]
    if invocation_first:
        sides.reverse()
    await asyncio.wait_for(asyncio.gather(*sides), 30)
    async with pg["factory"].begin() as db:
        links = list(
            await db.scalars(
                select(SessionWorkLink).where(
                    SessionWorkLink.workspace_id == pg["workspace_id"]
                )
            )
        )
    assert [
        (link.entity_id, link.relation, link.invocation_count) for link in links
    ] == [(pg["card_id"], "changed", 1)]


async def test_stale_api_key_requests_fit_the_production_pool(pg):
    """Concurrent stale-key requests on the real 3+2 pool: each stamps on the
    connection it already holds, so none waits on a second checkout."""
    engine = build_engine(pg["url"])
    factory = async_sessionmaker(engine, expire_on_commit=False)
    raw_keys = []
    try:
        async with factory.begin() as db:
            for index in range(5):
                api_key, raw = await ApiKeyService(db).create_key(
                    pg["owner_id"], f"stale-{index}"
                )
                api_key.last_used_at = api_key.created_at - timedelta(hours=6)
                raw_keys.append(raw)
        app = create_app()

        async def request_transaction():
            async with factory() as db:
                try:
                    yield db
                    await db.commit()
                except Exception:
                    await db.rollback()
                    raise

        app.dependency_overrides[get_db] = request_transaction
        async with AsyncClient(
            transport=ASGITransport(app), base_url="http://test"
        ) as client:
            responses = await asyncio.wait_for(
                asyncio.gather(
                    *(
                        client.get(
                            "/api/me", headers={"Authorization": "Bearer " + raw}
                        )
                        for raw in raw_keys
                    )
                ),
                20,
            )
        assert [response.status_code for response in responses] == [200] * 5
        async with factory() as db:
            stamps = list(
                await db.scalars(
                    select(ApiKey.last_used_at).where(ApiKey.user_id == pg["owner_id"])
                )
            )
        assert all(stamp is not None for stamp in stamps)
    finally:
        await engine.dispose()


async def test_identical_capture_racing_an_uncommitted_upload_is_acknowledged(pg):
    from app.services.agent_session_ingest import AgentSessionIngestService

    same = record(pg, FIXTURE_EVENTS)
    authorization = pg["headers"]["Authorization"]
    async with pg["factory"]() as first, pg["factory"]() as second:
        installation = await CompanionService(first).authenticate_device(authorization)
        first_result, _ = await AgentSessionIngestService(first).ingest(
            installation, [copy.deepcopy(same)]
        )
        assert first_result.acknowledged == [same["capture_id"]]

        async def racing_upload():
            other = await CompanionService(second).authenticate_device(authorization)
            return await AgentSessionIngestService(second).ingest(
                other, [copy.deepcopy(same)]
            )

        racing = asyncio.create_task(racing_upload())
        await asyncio.sleep(0.5)
        assert not racing.done(), "second upload should wait for the first"
        await first.commit()
        second_result, _ = await asyncio.wait_for(racing, 10)
        await second.commit()
    assert second_result.acknowledged == [same["capture_id"]]
    assert second_result.rejected == []
    async with pg["factory"].begin() as db:
        assert (
            await db.scalar(
                select(AgentSession.event_count).where(
                    AgentSession.owner_id == pg["owner_id"]
                )
            )
            == 7
        )


def _tool_event(session_id, call_id, event_id):
    event = copy.deepcopy(FIXTURE_EVENTS[3])
    event["event"]["id"] = event_id
    event["session"]["id"] = session_id
    event["gen_ai"]["tool"]["call"]["id"] = call_id
    return event


async def test_concurrent_multi_record_batches_in_opposite_orders_do_not_deadlock(pg):
    def batch(tag, order):
        records = {
            "x": record(
                pg,
                [_tool_event("thread-x", "call-x", f"{tag}-x")],
                native_session_id="thread-x",
            ),
            "y": record(
                pg,
                [_tool_event("thread-y", "call-y", f"{tag}-y")],
                native_session_id="thread-y",
            ),
        }
        return [records[key] for key in order]

    results = await asyncio.wait_for(
        asyncio.gather(
            *(
                post_batch(pg, batch(f"b{index}", "xy" if index % 2 else "yx"))
                for index in range(6)
            )
        ),
        30,
    )
    for result in results:
        assert result["rejected"] == [] and len(result["acknowledged"]) == 2
    async with pg["factory"].begin() as db:
        counts = dict(
            (
                await db.execute(
                    select(
                        AgentSession.native_session_id, AgentSession.event_count
                    ).where(AgentSession.owner_id == pg["owner_id"])
                )
            ).all()
        )
    assert counts == {"thread-x": 6, "thread-y": 6}


async def test_auto_mapping_conflicts_on_the_partial_repository_index(pg):
    # A racing second insert must infer the partial unique index and do
    # nothing, rather than fail to match any ON CONFLICT target.
    async with pg["factory"].begin() as db:
        installation_id = await db.scalar(
            select(CompanionInstallation.id).where(
                CompanionInstallation.owner_id == pg["owner_id"]
            )
        )
        repository = CompanionRepository(db)
        values = dict(
            installation_id=installation_id,
            workspace_id=pg["workspace_id"],
            board_id=None,
            repo_url_normalized="github.com/synthetic/app",
        )
        assert await repository.insert_auto_mapping(id=uuid.uuid4(), **values)
        assert not await repository.insert_auto_mapping(id=uuid.uuid4(), **values)


async def test_concurrent_retention_purges_delete_each_session_once(pg):
    from datetime import datetime, timezone

    from app.models.agent_session import AgentSessionTombstone
    from app.models.companion import CompanionInstallation
    from app.services.session_retention import SessionRetentionService

    old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat()
    records = []
    for index in range(6):
        event = copy.deepcopy(FIXTURE_EVENTS[0])
        event["event"]["id"] = f"retention-{index}"
        event["session"]["id"] = f"retention-{index}"
        event["timestamp"] = old
        records.append(record(pg, [event], native_session_id=f"retention-{index}"))
    assert (await post_batch(pg, records))["rejected"] == []
    async with pg["factory"].begin() as db:
        await db.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.owner_id == pg["owner_id"])
            .values(retention_days=3)
        )
    service = SessionRetentionService(pg["factory"])
    purged = await asyncio.wait_for(
        asyncio.gather(*(service.run_purge(batch_size=2) for _ in range(3))), 30
    )
    assert sum(purged) == 6
    async with pg["factory"].begin() as db:
        remaining = await db.scalar(
            select(func.count())
            .select_from(AgentSession)
            .where(AgentSession.owner_id == pg["owner_id"])
        )
        tombstones = await db.scalar(
            select(func.count())
            .select_from(AgentSessionTombstone)
            .where(AgentSessionTombstone.owner_id == pg["owner_id"])
        )
    assert (remaining, tombstones) == (0, 6)
    retry = await post_batch(pg, records[:1])
    assert retry["dropped"] == [
        {"capture_id": records[0]["capture_id"], "reason": "session_deleted"}
    ]


async def test_upload_racing_an_uncommitted_delete_is_dropped_not_resurrected(pg):
    from app.services.agent_session import AgentSessionService
    from app.services.agent_session_ingest import AgentSessionIngestService

    first = record(pg, FIXTURE_EVENTS[:2])
    assert (await post_batch(pg, [first]))["rejected"] == []
    async with pg["factory"]() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(AgentSession.owner_id == pg["owner_id"])
        )
    later_event = copy.deepcopy(FIXTURE_EVENTS[2])
    later_event["event"]["id"] = "after-delete"
    later = record(pg, [later_event])
    authorization = pg["headers"]["Authorization"]
    async with pg["factory"]() as deleting, pg["factory"]() as uploading:
        await AgentSessionService(deleting).delete_session(
            pg["workspace_id"], pg["owner_id"], session_id
        )

        async def racing_upload():
            installation = await CompanionService(uploading).authenticate_device(
                authorization
            )
            return await AgentSessionIngestService(uploading).ingest(
                installation, [copy.deepcopy(later)]
            )

        racing = asyncio.create_task(racing_upload())
        await asyncio.sleep(0.5)
        assert not racing.done(), "the upload should wait for the delete"
        await deleting.commit()
        result, _ = await asyncio.wait_for(racing, 10)
        await uploading.commit()
    assert result.acknowledged == [later["capture_id"]]
    assert [drop.reason for drop in result.dropped] == ["session_deleted"]
    async with pg["factory"]() as db:
        assert (
            await db.scalar(
                select(func.count())
                .select_from(AgentSession)
                .where(AgentSession.owner_id == pg["owner_id"])
            )
            == 0
        )


async def test_retention_lock_never_outlives_a_pass_on_a_pooled_connection(
    pg, monkeypatch
):
    """A pooled request interleaved with the purge must not inherit its lock,
    and another worker must be able to purge after the pass."""
    from datetime import datetime, timezone

    from sqlalchemy.pool import NullPool

    from app.models.companion import CompanionInstallation
    from app.services import session_retention
    from app.services.session_retention import PURGE_LOCK_KEY, SessionRetentionService

    async def upload_expired(tag):
        event = copy.deepcopy(FIXTURE_EVENTS[0])
        event["event"]["id"] = tag
        event["session"]["id"] = tag
        event["timestamp"] = (
            datetime.now(timezone.utc) - timedelta(days=10)
        ).isoformat()
        assert (await post_batch(pg, [record(pg, [event], native_session_id=tag)]))[
            "rejected"
        ] == []

    await upload_expired("first-pass")
    async with pg["factory"].begin() as db:
        await db.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.owner_id == pg["owner_id"])
            .values(retention_days=3)
        )

    held = []
    original = session_retention.AgentSessionRepository

    class InterleavingRepository(original):
        async def sessions_past_retention(self, *args, **kwargs):
            # Before the pass's first batch query, a request checks out the
            # most recently returned pooled connection and keeps it.
            if not held:
                request = pg["factory"]()
                await request.execute(text("select 1"))
                held.append(request)
            return await super().sessions_past_retention(*args, **kwargs)

    monkeypatch.setattr(
        session_retention, "AgentSessionRepository", InterleavingRepository
    )
    assert await SessionRetentionService(pg["factory"]).run_purge(batch_size=1) == 1
    monkeypatch.setattr(session_retention, "AgentSessionRepository", original)

    checker = create_async_engine(pg["url"], poolclass=NullPool)
    try:
        async with checker.connect() as connection:
            assert await connection.scalar(
                select(func.pg_try_advisory_lock(PURGE_LOCK_KEY))
            )
            await connection.scalar(select(func.pg_advisory_unlock(PURGE_LOCK_KEY)))
    finally:
        await checker.dispose()
        for request in held:
            await request.close()

    await upload_expired("second-pass")
    assert await SessionRetentionService(pg["factory"]).run_purge() == 1


async def test_concurrent_agent_key_rotations_leave_one_live_key(pg):
    async def rotate():
        return await pg["client"].post("/api/companion/agent-key", headers=pg["headers"])

    responses = await asyncio.wait_for(asyncio.gather(*(rotate() for _ in range(6))), 30)
    statuses = [response.status_code for response in responses]
    assert set(statuses) <= {201, 409}, [r.text for r in responses]
    assert 201 in statuses
    for response in responses:
        if response.status_code == 409:
            assert response.json()["error_code"] == "agent_key_rotation_conflict"
    async with pg["factory"].begin() as db:
        live = (
            await db.execute(
                select(ApiKey.id)
                .join(CompanionInstallation, ApiKey.installation_id == CompanionInstallation.id)
                .where(CompanionInstallation.owner_id == pg["owner_id"])
            )
        ).scalars().all()
    assert len(live) == 1


async def test_calls_page_groups_on_postgresql(pg):
    """The calls query groups on a computed anchor; PostgreSQL rejects a GROUP
    BY whose expression carries bind parameters that differ from the SELECT's."""
    assert (await post_batch(pg, [record(pg, FIXTURE_EVENTS)]))["rejected"] == []
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(AgentSession.owner_id == pg["owner_id"])
        )
        service = SessionCallService(db)
        first = await service.list_calls(
            pg["workspace_id"], pg["owner_id"], session_id, limit=2
        )
        earlier = await service.list_calls(
            pg["workspace_id"],
            pg["owner_id"],
            session_id,
            cursor=first.next_cursor,
            limit=2,
        )
        failures = await service.list_calls(
            pg["workspace_id"], pg["owner_id"], session_id, call_filter="failures"
        )
    timeline = earlier.items + first.items
    assert [item.kind for item in timeline] == ["prompt", "mcp", "tool"]
    assert earlier.next_cursor is None
    assert timeline[1].event_count == 2
    assert [turn.call_count for turn in first.turns] == [2]
    assert [item.call_id for item in failures.items] == ["toolu_evidence_2"]


async def _synthetic_sessions(pg) -> list[AgentSession]:
    """Five sessions with distinct spans, tokens and costs (one unpriced),
    the newest linked to the card."""
    async with pg["factory"].begin() as db:
        installation_id = await db.scalar(
            select(CompanionProjectMapping.installation_id).where(
                CompanionProjectMapping.id == pg["mapping_id"]
            )
        )
        now = await db.scalar(select(func.now()))
        rows = []
        for index, (cost, tokens) in enumerate(
            [(1.5, 10), (0.25, 500), (0.25, 500), (None, 0), (0.000001, 7)]
        ):
            session = AgentSession(
                workspace_id=pg["workspace_id"],
                owner_id=pg["owner_id"],
                installation_id=installation_id,
                harness="claude_code",
                native_session_id=f"pg-sort-{index}",
                started_at=now - timedelta(hours=index + 1, minutes=index * 7),
                last_event_at=now - timedelta(minutes=index * 3),
                title=f"Postgres 50% session {index}" if index % 2 else None,
                input_tokens=tokens,
                cost_usd=cost,
            )
            db.add(session)
            rows.append(session)
        await db.flush()
        db.add(
            SessionWorkLink(
                session_id=rows[0].id,
                workspace_id=pg["workspace_id"],
                entity_type="card",
                entity_id=pg["card_id"],
                board_id=pg["board_id"],
                relation="changed",
                first_seen_at=now,
                last_seen_at=now,
                invocation_count=1,
            )
        )
    return rows


async def test_session_list_filters_and_sorts_on_postgresql(pg):
    rows = await _synthetic_sessions(pg)

    def ids(page):
        return [item.id for item in page.items]

    async with pg["factory"].begin() as db:
        service = AgentSessionService(db)
        for sort in ("recent", "started", "duration", "tokens", "cost"):
            walked, cursor = [], None
            while True:
                page = await service.list_sessions(
                    pg["workspace_id"],
                    pg["owner_id"],
                    sort=sort,
                    cursor=cursor,
                    limit=2,
                )
                walked += ids(page)
                if (cursor := page.next_cursor) is None:
                    break
            whole = await service.list_sessions(
                pg["workspace_id"], pg["owner_id"], sort=sort, limit=50
            )
            assert walked == ids(whole), sort
            assert len(set(walked)) == len(rows), sort
        by_cost = await service.list_sessions(
            pg["workspace_id"], pg["owner_id"], sort="cost", limit=50
        )
        assert by_cost.items[0].cost_usd == 1.5
        assert by_cost.items[-1].cost_usd is None  # NULLS LAST on PostgreSQL too
        searched = await service.list_sessions(
            pg["workspace_id"], pg["owner_id"], q="50%", limit=50
        )
        assert {item.id for item in searched.items} == {rows[1].id, rows[3].id}
        by_board = await service.list_sessions(
            pg["workspace_id"], pg["owner_id"], q="synthetic BOARD", limit=50
        )
        assert by_board.items == []  # these rows carry no board_id
        live = await service.list_sessions(
            pg["workspace_id"], pg["owner_id"], states=["active", "idle"], limit=50
        )
        assert {item.display_state for item in live.items} <= {"active", "idle"}
        linked = await service.list_sessions(
            pg["workspace_id"], pg["owner_id"], linked_only=True, limit=50
        )
        assert ids(linked) == [rows[0].id]
        assert linked.items[0].link_count == 1
        assert linked.items[0].link_preview[0].title == "Synthetic card"


async def test_period_summary_keeps_bases_apart_on_postgresql(pg):
    rows = await _synthetic_sessions(pg)
    async with pg["factory"].begin() as db:
        await db.execute(
            update(AgentSession)
            .where(AgentSession.id == rows[0].id)
            .values(auth_kind="api")
        )
        offline = await AgentSessionService(db).period_summary(
            pg["workspace_id"], pg["owner_id"]
        )
        await db.execute(
            update(CompanionInstallation)
            .where(CompanionInstallation.owner_id == pg["owner_id"])
            .values(last_seen_at=func.now())
        )
        summary = await AgentSessionService(db).period_summary(
            pg["workspace_id"], pg["owner_id"]
        )
    assert offline.live_count == 0  # a device that never checked in is disconnected
    assert summary.session_count == 5
    assert summary.cost_spend_usd == 1.5
    assert summary.cost_api_equivalent_usd == 0.500001
    assert summary.input_tokens == 1017
    assert summary.cost_complete is True  # the unpriced row used no tokens
    assert summary.live_count == 5
    # The spans all reach back to the oldest start: one stretch of time.
    assert summary.wall_duration_seconds == pytest.approx(5 * 3600 + 28 * 60, abs=1)


async def test_rhythm_buckets_on_postgresql(pg):
    assert (await post_batch(pg, [record(pg, FIXTURE_EVENTS)]))["rejected"] == []
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(AgentSession.owner_id == pg["owner_id"])
        )
        rhythm = await SessionRhythmService(db).rhythm(
            pg["workspace_id"], pg["owner_id"], session_id, buckets=3
        )
    totals = {
        kind: sum(getattr(bucket, kind) for bucket in rhythm.buckets)
        for kind in ("prompt", "tool", "file", "work", "error")
    }
    # The calls page shows prompt, mcp and tool; the tool call failed.
    assert totals == {"prompt": 1, "tool": 1, "file": 0, "work": 0, "error": 1}
    assert len(rhythm.buckets) == 3 and rhythm.live is False


async def test_rhythm_of_a_very_large_session_stays_fast_on_postgresql(pg):
    """Card d0f793fa: bucketing happens in one aggregate, so 30k events cost
    one scan, not a page walk."""
    event_count = 30_000
    async with pg["factory"].begin() as db:
        installation_id = await db.scalar(
            select(CompanionProjectMapping.installation_id).where(
                CompanionProjectMapping.id == pg["mapping_id"]
            )
        )
        now = await db.scalar(select(func.now()))
        start = now - timedelta(days=3)
        session = AgentSession(
            workspace_id=pg["workspace_id"],
            owner_id=pg["owner_id"],
            installation_id=installation_id,
            harness="claude_code",
            native_session_id="pg-large",
            started_at=start,
            last_event_at=start + timedelta(seconds=2 * event_count),
        )
        db.add(session)
        await db.flush()
        await db.execute(
            AgentSessionEvent.__table__.insert(),
            [
                {
                    "id": uuid.uuid4(),
                    "session_id": session.id,
                    "event_id": f"large-{index}",
                    "capture_id": "c" * 32,
                    "occurred_at": start + timedelta(seconds=2 * index),
                    "received_at": now,
                    "action": "tool.invoked" if index % 2 == 0 else "tool.completed",
                    "collection_method": "hook",
                    "tool_name": "Edit" if index % 10 < 2 else "Bash",
                    "native_tool_call_id": f"call-{index // 2}",
                    "outcome": "succeeded" if index % 2 else None,
                    "event": {},
                }
                for index in range(event_count)
            ],
        )
    async with pg["factory"].begin() as db:
        started = time.perf_counter()
        rhythm = await SessionRhythmService(db).rhythm(
            pg["workspace_id"], pg["owner_id"], session.id, buckets=240
        )
        elapsed = time.perf_counter() - started
    calls = event_count // 2
    assert sum(b.tool + b.file for b in rhythm.buckets) == calls
    assert sum(b.file for b in rhythm.buckets) == calls // 5
    assert len(rhythm.buckets) == 240
    assert elapsed < 3, elapsed


def _timed(events, prefix, at, native):
    timed = []
    for index, event in enumerate(copy.deepcopy(events)):
        event["event"]["id"] = f"{prefix}-{index}"
        event["session"]["id"] = native
        event["timestamp"] = (at + timedelta(milliseconds=index)).isoformat()
        timed.append(event)
    return timed


async def _tombstone_of(pg, native):
    from app.models.agent_session import AgentSessionTombstone

    async with pg["factory"]() as db:
        return await db.scalar(
            select(AgentSessionTombstone).where(
                AgentSessionTombstone.owner_id == pg["owner_id"],
                AgentSessionTombstone.native_session_id == native,
            )
        )


async def _stored_event_ids(pg):
    async with pg["factory"]() as db:
        return set(
            await db.scalars(
                select(AgentSessionEvent.event_id)
                .join(AgentSession, AgentSession.id == AgentSessionEvent.session_id)
                .where(AgentSession.owner_id == pg["owner_id"])
            )
        )


async def test_deletes_cut_history_on_postgresql_from_a_fast_device_clock(pg):
    """The owner delete, the bulk delete and ingest, on PostgreSQL's types:
    the clock lead is NUMERIC there, and the cutoff must still be computed,
    stored monotonically, and honoured."""
    from datetime import datetime, timezone

    from app.core.time import as_utc
    from app.models.companion import CompanionInstallation

    native = "fast-clock-session"
    stamped = datetime.now(timezone.utc) + timedelta(hours=1)
    before = record(
        pg,
        _timed(FIXTURE_EVENTS[:3], "before", stamped, native),
        native_session_id=native,
        captured_at=stamped.isoformat(),
    )
    assert (await post_batch(pg, [before]))["rejected"] == []
    async with pg["factory"].begin() as db:
        session_id = await db.scalar(
            select(AgentSession.id).where(AgentSession.owner_id == pg["owner_id"])
        )
        await AgentSessionService(db).delete_session(
            pg["workspace_id"], pg["owner_id"], session_id
        )
    first = await _tombstone_of(pg, native)
    assert as_utc(first.history_cutoff) > stamped
    assert first.history_cutoff_deleted_at == first.deleted_at

    retried = await post_batch(pg, [before])
    assert [drop["reason"] for drop in retried["dropped"]] == ["session_deleted"]
    resumed_at = as_utc(first.history_cutoff) + timedelta(seconds=30)
    resumed = record(
        pg,
        _timed(FIXTURE_EVENTS[:3], "resumed", resumed_at, native),
        native_session_id=native,
        captured_at=resumed_at.isoformat(),
    )
    result = await post_batch(pg, [resumed])
    assert result["dropped"] == []
    assert [history["reason"] for history in result["history_deleted"]] == ["owner"]
    assert await _stored_event_ids(pg) == {"resumed-0", "resumed-1", "resumed-2"}

    async with pg["factory"].begin() as db:
        installation_id = await db.scalar(
            select(CompanionInstallation.id).where(
                CompanionInstallation.owner_id == pg["owner_id"]
            )
        )
        deletion, _ = await CompanionService(db).delete_sessions(
            pg["owner_id"], installation_id
        )
    assert deletion.deleted == 1
    second = await _tombstone_of(pg, native)
    assert as_utc(second.history_cutoff) >= as_utc(first.history_cutoff)
    assert as_utc(second.history_cutoff) > resumed_at
    assert (await post_batch(pg, [resumed]))["dropped"] != []
    assert await _stored_event_ids(pg) == set()
