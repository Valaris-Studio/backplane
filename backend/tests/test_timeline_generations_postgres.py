# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Only TIMELINE_TEST_DATABASE_URL, an explicitly disposable migrated database."""

import os
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import database
from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

pytestmark = [pytest.mark.slow, pytest.mark.timeout(20)]


@pytest_asyncio.fixture
async def postgres_history(monkeypatch):
    url = os.environ.get("TIMELINE_TEST_DATABASE_URL")
    if not url:
        pytest.skip("Requires explicit disposable migrated TIMELINE_TEST_DATABASE_URL")
    engine = create_async_engine(url, hide_parameters=True, pool_size=3, max_overflow=1)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    suffix = uuid.uuid4().hex
    async with factory.begin() as db:
        user = User(id=uuid.uuid4(), email=f"timeline-{suffix}@example.test", name="Timeline test")
        db.add(user)
        await db.flush()
        workspace = Workspace(id=uuid.uuid4(), name="Timeline fixture", slug=f"timeline-{suffix}", created_by=user.id)
        db.add(workspace)
        await db.flush()
        db.add(WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.owner))
        board = Board(id=uuid.uuid4(), workspace_id=workspace.id, name="Timeline fixture", slug="timeline", created_by=user.id)
        db.add(board)
    monkeypatch.setattr(database, "async_session", factory)
    app = create_app()

    async def request_db():
        async with factory() as db:
            yield db
            await db.commit()

    async def owner():
        return user

    app.dependency_overrides[get_db] = request_db
    app.dependency_overrides[get_current_user] = owner
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            yield {
                "client": client, "factory": factory,
                "base": f"/api/workspaces/{workspace.slug}/boards/{board.id}/timeline",
                "values": {"workspace": workspace.id, "board": board.id, "actor": user.id},
            }
    finally:
        async with factory.begin() as db:
            await db.execute(delete(Workspace).where(Workspace.id == workspace.id))
            await db.execute(delete(User).where(User.id == user.id))
        await engine.dispose()


async def insert_old_writer(db, values, summary):
    # The database must supply seq/provenance for an unchanged rolling writer.
    return (await db.execute(text("""
        INSERT INTO activities
          (id, workspace_id, board_id, actor_id, entity_type, entity_id, action, summary)
        VALUES (:id, :workspace, :board, :actor, 'board', :board, 'updated', :summary)
        RETURNING id, seq
    """), {**values, "id": uuid.uuid4(), "summary": summary})).one()


async def establish(fixture):
    response = await fixture["client"].post(
        f"{fixture['base']}/generations", json={"request_id": str(uuid.uuid4())}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_postgres_late_lower_sequence_stays_out_of_frozen_generation(postgres_history):
    fixture = postgres_history
    async with fixture["factory"]() as early:
        lower = await insert_old_writer(early, fixture["values"], "allocated first, committed last")
        async with fixture["factory"].begin() as later:
            upper = await insert_old_writer(later, fixture["values"], "visible when opened")
        assert lower.seq < upper.seq
        frozen = await establish(fixture)
        assert frozen["event_count"] == "1"
        assert frozen["first_seq"] == frozen["head_seq"] == str(upper.seq)
        await early.commit()
    base = f"{fixture['base']}/generations"
    response = await fixture["client"].get(f"{base}/{frozen['id']}/window")
    assert response.status_code == 200, response.text
    assert [event["seq"] for event in response.json()["events"]] == [str(upper.seq)]
    refreshed = await establish(fixture)
    assert refreshed["event_count"] == "2"
    response = await fixture["client"].get(f"{base}/{refreshed['id']}/window")
    assert response.status_code == 200, response.text
    assert [event["seq"] for event in response.json()["events"]] == [str(lower.seq), str(upper.seq)]


async def test_postgres_old_writer_default_is_top_level_xid_and_rollback_leaves_no_event(postgres_history):
    fixture = postgres_history
    async with fixture["factory"].begin() as db:
        outer_xid = await db.scalar(text("SELECT pg_current_xact_id()::text"))
        kept = await insert_old_writer(db, fixture["values"], "kept")
        async with db.begin_nested() as savepoint:
            dropped = await insert_old_writer(db, fixture["values"], "rolled back")
            provenance = (await db.execute(text("""
                SELECT recorded_transaction::text AS xid,
                       pg_typeof(recorded_transaction)::text AS type
                FROM activities WHERE id = :id
            """), {"id": dropped.id})).one()
            assert provenance.xid == outer_xid
            assert provenance.type == "xid8"
            await savepoint.rollback()
        assert await db.scalar(text("SELECT count(*) FROM activities WHERE id = :id"), {"id": dropped.id}) == 0
        assert await db.scalar(text("SELECT recorded_transaction::text FROM activities WHERE id = :id"), {"id": kept.id}) == outer_xid
    generation = await establish(fixture)
    assert generation["event_count"] == "1"


async def test_postgres_expired_generation_is_gone_without_changing_retry_identity(postgres_history):
    fixture = postgres_history
    request_id = str(uuid.uuid4())
    response = await fixture["client"].post(f"{fixture['base']}/generations", json={"request_id": request_id})
    assert response.status_code == 201, response.text
    generation = response.json()
    async with fixture["factory"].begin() as db:
        await db.execute(text("""
            UPDATE timeline_generations SET expires_at = now() - interval '1 second'
            WHERE id = :id
        """), {"id": uuid.UUID(generation["id"])})
    for suffix in ("", "/overview", "/window", "/live-head", "/search?q=test"):
        response = await fixture["client"].get(f"{fixture['base']}/generations/{generation['id']}{suffix}")
        assert response.status_code == 410, response.text
    response = await fixture["client"].post(f"{fixture['base']}/generations", json={"request_id": request_id})
    assert response.status_code == 410


async def test_postgres_generation_authorizes_and_observes_in_repeatable_read(postgres_history):
    from sqlalchemy import event

    fixture = postgres_history
    engine = fixture["factory"].kw["bind"].sync_engine
    reads = []

    def record_isolation(connection, cursor, statement, parameters, context, executemany):
        normalized = statement.lower()
        if normalized.lstrip().startswith("select") and any(
            name in normalized for name in ("workspaces", "workspace_members", "boards", "activities")
        ):
            isolation = connection.exec_driver_sql("SHOW transaction_isolation").scalar_one()
            reads.append((normalized, isolation))

    event.listen(engine, "before_cursor_execute", record_isolation)
    try:
        await establish(fixture)
    finally:
        event.remove(engine, "before_cursor_execute", record_isolation)
    assert reads, "generation must authorize and capture source data"
    assert all(isolation == "repeatable read" for _, isolation in reads), reads
    assert any("workspace_members" in statement for statement, _ in reads)
    assert any("activities" in statement for statement, _ in reads)


async def test_postgres_preparation_resumes_checkpoint_after_failure_and_idempotent_retry(postgres_history, monkeypatch):
    fixture = postgres_history
    async with fixture["factory"].begin() as db:
        records = [await insert_old_writer(db, fixture["values"], f"event {i}") for i in range(7)]
    generation = await establish(fixture)
    from app.services import timeline

    monkeypatch.setattr(timeline, "INLINE_REPLAY_LIMIT", 2)
    path = f"{fixture['base']}/generations/{generation['id']}"
    params = {"at_seq": str(records[-1].seq), "limit": 1}
    response = await fixture["client"].get(f"{path}/window", params=params)
    assert response.status_code == 202, response.text
    work = response.json()
    repeated = await fixture["client"].get(f"{path}/window", params=params)
    assert repeated.json()["preparation_id"] == work["preparation_id"]
    await timeline.process_pending_timeline_preparations(batch_size=2, max_jobs=1)
    progress = (await fixture["client"].get(f"{path}/window", params=params)).json()
    assert progress["progress"]["processed_events"] == "2"
    assert progress["progress"]["through_seq"] == str(records[1].seq)

    original_fold = timeline.fold_events

    def fail_batch(*args, **kwargs):
        raise RuntimeError("synthetic replay batch failure")

    monkeypatch.setattr(timeline, "fold_events", fail_batch)
    await timeline.process_pending_timeline_preparations(batch_size=2, max_jobs=1)
    failed = (await fixture["client"].get(f"{path}/window", params=params)).json()
    assert failed["status"] == "failed"
    assert failed["retryable"] is True
    assert failed["progress"] == progress["progress"]
    assert failed["error"]["code"]
    monkeypatch.setattr(timeline, "fold_events", original_fold)
    retry_path = f"{path}/preparations/{work['preparation_id']}/retry"
    for _ in range(2):
        retried = await fixture["client"].post(retry_path)
        assert retried.status_code in (200, 202), retried.text
        assert retried.json()["preparation_id"] == work["preparation_id"]
    for _ in range(2):
        await timeline.process_pending_timeline_preparations(batch_size=2, max_jobs=1)
    ready = await fixture["client"].get(f"{path}/window", params=params)
    assert ready.status_code == 200, ready.text
    assert ready.json()["status"] == "ready"
    assert ready.json()["anchor"]["through_seq"] == str(records[-2].seq)
    assert [event["seq"] for event in ready.json()["events"]] == [str(records[-1].seq)]


async def test_postgres_checkpoint_reuse_depends_on_visible_prefix_not_new_head(postgres_history, monkeypatch):
    import json

    fixture = postgres_history
    async with fixture["factory"]() as early:
        lower = await insert_old_writer(early, fixture["values"], "late creation")
        card_id = str(uuid.uuid4())
        snapshot = {
            "id": card_id, "title": "Late but earlier", "card_type": "feature",
            "priority": "medium", "column_id": None, "position": 0,
            "status": None, "labels": [], "participants": [],
        }
        await early.execute(text("""
            UPDATE activities SET entity_type='card', entity_id=:card_id,
                action='created', after_state=CAST(:snapshot AS json)
            WHERE id=:id
        """), {"card_id": uuid.UUID(card_id), "snapshot": json.dumps(snapshot), "id": lower.id})
        async with fixture["factory"].begin() as db:
            records = [await insert_old_writer(db, fixture["values"], f"visible {i}") for i in range(7)]
        frozen = await establish(fixture)
        from app.services import timeline

        monkeypatch.setattr(timeline, "INLINE_REPLAY_LIMIT", 2)
        params = {"at_seq": str(records[-1].seq), "limit": 1}

        async def window(generation):
            return await fixture["client"].get(
                f"{fixture['base']}/generations/{generation['id']}/window", params=params
            )

        assert (await window(frozen)).status_code == 202
        for _ in range(3):
            await timeline.process_pending_timeline_preparations(batch_size=2, max_jobs=1)
        old_page = await window(frozen)
        assert old_page.status_code == 200, old_page.text
        assert old_page.json()["anchor"]["state"]["cards"] == []
        async with fixture["factory"].begin() as db:
            await insert_old_writer(db, fixture["values"], "new head outside cached prefix")
        same_prefix = await establish(fixture)
        reused = await window(same_prefix)
        assert reused.status_code == 200, "unchanged prefix should reuse its ready checkpoint"
        assert reused.json()["anchor"] == old_page.json()["anchor"]
        await early.commit()
    changed_prefix = await establish(fixture)
    invalidated = await window(changed_prefix)
    assert invalidated.status_code == 202, "newly visible lower seq must invalidate the cached prefix"
    for _ in range(4):
        await timeline.process_pending_timeline_preparations(batch_size=2, max_jobs=1)
    new_page = await window(changed_prefix)
    assert new_page.status_code == 200, new_page.text
    assert [card["id"] for card in new_page.json()["anchor"]["state"]["cards"]] == [card_id]
    assert (await window(frozen)).json()["anchor"] == old_page.json()["anchor"]


async def test_postgres_real_board_creation_resolves_known_empty_genesis(postgres_history):
    from app.services.timeline_replay import fold_events

    fixture = postgres_history
    boards_path = fixture["base"].split("/boards/", 1)[0] + "/boards"
    created = await fixture["client"].post(boards_path, json={"name": "Postgres captured genesis"})
    assert created.status_code == 201, created.text
    board = created.json()
    base = f"{boards_path}/{board['id']}/timeline"
    response = await fixture["client"].post(f"{base}/generations", json={"request_id": str(uuid.uuid4())})
    assert response.status_code == 201, response.text
    generation = response.json()
    response = await fixture["client"].get(f"{base}/generations/{generation['id']}/window")
    assert response.status_code == 200, response.text
    page = response.json()
    assert page["anchor"]["coverage"]["unknown_origin"] is False
    assert page["coverage"]["quality"] == "reconstructed"
    columns = [event for event in page["events"] if event["entity_type"] == "column" and event["action"] == "created"]
    assert columns, "the known-empty marker must not discard earlier default-column events"
    projected = fold_events(
        page["events"], initial_state=page["anchor"]["state"], initial_coverage=page["anchor"]["coverage"]
    )
    live = await fixture["client"].get(f"{base}/generations/{generation['id']}/live-head")
    assert live.status_code == 200, live.text
    assert projected["state"]["columns"] == live.json()["state"]["columns"]


async def test_postgres_date_seek_keeps_sequence_neighbors_and_search_cursor_scope(postgres_history):
    from datetime import datetime, timedelta, timezone

    fixture = postgres_history
    origin = datetime(2026, 10, 8)
    async with fixture["factory"].begin() as db:
        records = [
            await insert_old_writer(db, fixture["values"], summary)
            for summary in ("needle first", "time target", "NEEDLE last")
        ]
        for record, day in zip(records, (2, 1, 0), strict=True):
            await db.execute(text("UPDATE activities SET created_at=:occurred_at WHERE id=:id"), {
                "id": record.id, "occurred_at": origin + timedelta(days=day),
            })
    generation = await establish(fixture)
    path = f"{fixture['base']}/generations/{generation['id']}"
    overview = await fixture["client"].get(f"{path}/overview", params={"buckets": 2})
    assert overview.status_code == 200, overview.text
    body = overview.json()
    assert body["event_count"] == "3"
    assert len(body["buckets"]) <= 2
    assert sum(int(bucket["count"]) for bucket in body["buckets"]) == 3
    assert datetime.fromisoformat(body["first_at"].replace("Z", "+00:00")) == origin.replace(tzinfo=timezone.utc)
    assert datetime.fromisoformat(body["last_at"].replace("Z", "+00:00")) == (origin + timedelta(days=2)).replace(tzinfo=timezone.utc)
    assert "events" not in body and "state" not in body
    window = await fixture["client"].get(f"{path}/window", params={"at_time": "2026-10-09T00:00:00Z", "limit": 2})
    assert window.status_code == 200, window.text
    assert [event["seq"] for event in window.json()["events"]] == [str(record.seq) for record in records[1:]]
    search = await fixture["client"].get(f"{path}/search", params={"q": "needle", "limit": 1})
    assert search.status_code == 200, search.text
    assert search.json()["scope"] == "generation"
    assert [match["seq"] for match in search.json()["matches"]] == [str(records[0].seq)]
    cursor = search.json()["next_cursor"]
    assert cursor
    continuation = await fixture["client"].get(f"{path}/search", params={"q": "needle", "limit": 1, "cursor": cursor})
    assert continuation.status_code == 200, continuation.text
    assert [match["seq"] for match in continuation.json()["matches"]] == [str(records[2].seq)]
    wrong_purpose = await fixture["client"].get(f"{path}/window", params={"cursor": cursor})
    assert wrong_purpose.status_code == 404
