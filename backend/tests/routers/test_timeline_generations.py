# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Public contract for bounded history; PostgreSQL visibility has its own seam tests."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app import database
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.workspace import Workspace


@pytest.fixture
def history_factory(monkeypatch, db_engine):
    # Generation establishment owns a new transaction, not the request session.
    factory = async_sessionmaker(db_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", factory)
    return factory


def timeline_path(board):
    return f"/api/workspaces/default/boards/{board.id}/timeline"


def activity(board, workspace, user, *, seq, summary):
    return Activity(
        workspace_id=workspace.id,
        board_id=board.id,
        actor_id=user.id,
        entity_type=ActivityEntityType.board,
        entity_id=board.id,
        action=ActivityAction.updated,
        seq=seq,
        created_at=datetime(2026, 10, 8, tzinfo=timezone.utc) + timedelta(seconds=seq % 10),
        summary=summary,
    )


async def establish(client, base, request_id=None):
    response = await client.post(
        f"{base}/generations", json={"request_id": request_id or str(uuid.uuid4())}
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


async def test_generation_retry_is_stable_refresh_includes_new_event(
    client, db_session, test_board, test_workspace, test_user, history_factory
):
    db_session.add(activity(test_board, test_workspace, test_user, seq=1, summary="first"))
    await db_session.commit()
    base = timeline_path(test_board)
    request_id = str(uuid.uuid4())
    first = await establish(client, base, request_id)
    db_session.add(activity(test_board, test_workspace, test_user, seq=2, summary="later"))
    await db_session.commit()
    retry = await establish(client, base, request_id)
    refreshed = await establish(client, base)

    assert retry == first
    assert first["event_count"] == "1"
    assert refreshed["id"] != first["id"]
    assert refreshed["event_count"] == "2"
    assert first["first_seq"] == first["head_seq"] == "1"
    assert refreshed["head_seq"] == "2"
    assert first["expires_at"] > first["created_at"]


async def test_overview_and_pages_preserve_large_sequences_without_live_baseline(
    client, db_session, test_board, test_workspace, test_user, history_factory
):
    first_seq = 2**53 - 2
    expected = [str(first_seq + index) for index in range(7)]
    db_session.add_all([
        activity(test_board, test_workspace, test_user, seq=int(seq), summary=f"event {index}")
        for index, seq in enumerate(expected)
    ])
    await db_session.commit()
    base = timeline_path(test_board)
    generation = await establish(client, base)
    scoped = f"{base}/generations/{generation['id']}"
    overview = await client.get(f"{scoped}/overview", params={"buckets": 2})
    assert overview.status_code == 200, overview.text
    body = overview.json()
    assert body["event_count"] == "7"
    assert body["first_seq"] == expected[0]
    assert body["head_seq"] == expected[-1]
    assert sum(int(bucket["count"]) for bucket in body["buckets"]) == 7
    assert 1 <= len(body["buckets"]) <= 2
    assert "state" not in body and "events" not in body

    seen = []
    params = {"limit": 2, "at_seq": expected[0]}
    for _ in range(4):
        response = await client.get(f"{scoped}/window", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        assert page["status"] == "ready"
        assert len(page["events"]) <= 2
        assert "baseline" not in page
        assert page["anchor"]["coverage"]["unknown_origin"] is True
        assert page["anchor"]["coverage"]["missing_structural_snapshots"] == "0"
        assert page["anchor"]["state"] == {"columns": [], "cards": []}
        sequences = [event["seq"] for event in page["events"]]
        assert page["window"]["first_seq"] == sequences[0]
        assert page["window"]["last_seq"] == sequences[-1]
        if seen:
            assert page["anchor"]["through_seq"] == seen[-1]
        seen.extend(sequences)
        cursor = page["window"]["next_cursor"]
        if cursor is None:
            break
        params = {"limit": 2, "cursor": cursor}
    assert seen == expected


async def test_empty_generation_has_null_bounds_and_distinct_observed_head(
    client, db_session, test_board, history_factory
):
    await db_session.commit()
    base = timeline_path(test_board)
    generation = await establish(client, base)
    scoped = f"{base}/generations/{generation['id']}"
    assert generation["event_count"] == "0"
    assert generation["first_seq"] is generation["head_seq"] is None
    overview = (await client.get(f"{scoped}/overview")).json()
    assert overview["first_at"] is overview["last_at"] is None
    assert overview["buckets"] == []
    page = (await client.get(f"{scoped}/window")).json()
    assert page["events"] == []
    assert page["window"] == {
        "first_seq": None, "last_seq": None,
        "previous_cursor": None, "next_cursor": None,
    }
    live = await client.get(f"{scoped}/live-head")
    assert live.status_code == 200, live.text
    assert live.json()["generation_id"] == generation["id"]
    assert "observed_at" in live.json()
    assert "anchor" not in live.json()


async def test_generation_and_cursor_cannot_cross_board_scope(
    client, db_session, test_board, test_workspace, test_user, history_factory
):
    other = Board(workspace_id=test_workspace.id, name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    db_session.add_all([
        activity(test_board, test_workspace, test_user, seq=index, summary=f"source {index}")
        for index in range(1, 4)
    ])
    await db_session.commit()
    base = timeline_path(test_board)
    generation = await establish(client, base)
    other_generation = await establish(client, timeline_path(other))
    response = await client.get(f"{timeline_path(other)}/generations/{generation['id']}/overview")
    assert response.status_code == 404
    page = await client.get(f"{base}/generations/{generation['id']}/window", params={"at_seq": "1", "limit": 1})
    assert page.status_code == 200, page.text
    cursor = page.json()["window"]["next_cursor"]
    assert cursor
    foreign = await client.get(
        f"{timeline_path(other)}/generations/{other_generation['id']}/window",
        params={"cursor": cursor},
    )
    assert foreign.status_code == 404
    malformed = await client.get(f"{base}/generations/{generation['id']}/window", params={"cursor": "not-a-cursor"})
    assert malformed.status_code == 422


async def test_generation_establishment_denies_nonmember_in_owned_transaction(
    client, db_session, second_user, history_factory
):
    workspace = Workspace(name="Private", slug="private-history", created_by=second_user.id)
    db_session.add(workspace)
    await db_session.flush()
    board = Board(workspace_id=workspace.id, name="Private", slug="private", created_by=second_user.id)
    db_session.add(board)
    await db_session.commit()
    response = await client.post(
        f"/api/workspaces/private-history/boards/{board.id}/timeline/generations",
        json={"request_id": str(uuid.uuid4())},
    )
    assert response.status_code == 403


async def test_new_board_records_explicit_known_empty_genesis(client, db_session, test_workspace):
    response = await client.post(
        "/api/workspaces/default/boards", json={"name": "Captured from genesis"}
    )
    assert response.status_code == 201, response.text
    board_id = uuid.UUID(response.json()["id"])
    records = list((await db_session.scalars(
        select(Activity).where(Activity.board_id == board_id).order_by(Activity.seq)
    )).all())
    genesis = next(row for row in records if row.entity_type == ActivityEntityType.board and row.action == ActivityAction.created)
    assert (genesis.changes or {}).get("timeline_genesis") == {"version": 1, "known_empty": True}
    # Default columns precede board.created; genesis describes the transaction's
    # starting state, not an instruction to erase columns when its row is folded.
    assert any(row.entity_type == ActivityEntityType.column and row.seq < genesis.seq for row in records)


async def test_generation_preserves_agent_principal_and_actor_label_after_rename(
    client, db_session, test_board, test_workspace, test_user, test_agent, history_factory
):
    deleted_agent_id = uuid.uuid4()
    durable = activity(test_board, test_workspace, test_user, seq=1, summary="durable principal")
    durable.principal_key = str(deleted_agent_id)
    durable.agent_id = None
    legacy = activity(test_board, test_workspace, test_user, seq=2, summary="legacy principal")
    legacy.principal_key = None
    legacy.agent_id = test_agent.id
    db_session.add_all([durable, legacy])
    await db_session.commit()
    original_name = test_user.name
    base = timeline_path(test_board)
    generation = await establish(client, base)
    path = f"{base}/generations/{generation['id']}/window"
    first_response = await client.get(path)
    assert first_response.status_code == 200, first_response.text
    events = first_response.json()["events"]
    assert [event["agent_id"] for event in events] == [str(deleted_agent_id), str(test_agent.id)]
    assert [event["actor_name"] for event in events] == [original_name, original_name]
    test_user.name = "Renamed after this generation"
    await db_session.commit()
    repeated = await client.get(path)
    assert repeated.status_code == 200, repeated.text
    assert [event["actor_name"] for event in repeated.json()["events"]] == [original_name, original_name]
    assert [event["agent_id"] for event in repeated.json()["events"]] == [str(deleted_agent_id), str(test_agent.id)]


async def test_checkpoint_budget_preserves_replay_after_an_old_anchor_is_evicted(
    client, db_session, test_board, test_workspace, test_user, history_factory, monkeypatch
):
    from sqlalchemy import func
    from app.models.timeline import TimelineCheckpoint
    from app.repositories import timeline as repository
    from app.services import timeline as service

    monkeypatch.setattr(repository, "MAX_CHECKPOINTS_PER_GENERATION", 3, raising=False)
    monkeypatch.setattr(service, "INLINE_REPLAY_LIMIT", 1)
    column_id = uuid.uuid4()
    rows = [activity(test_board, test_workspace, test_user, seq=i, summary=f"event {i}") for i in range(1, 13)]
    rows[0].entity_type = ActivityEntityType.column
    rows[0].entity_id = column_id
    rows[0].action = ActivityAction.created
    rows[0].after_state = {"id": str(column_id), "name": "Known from the beginning", "column_type": "active", "position": 1024}
    db_session.add_all(rows)
    await db_session.commit()
    generation = await establish(client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"

    async def prepare_window(at_seq):
        for _ in range(20):
            response = await client.get(path, params={"at_seq": str(at_seq), "limit": 1})
            assert response.status_code in (200, 202), response.text
            page = response.json()
            if page["status"] == "ready":
                return page
            assert page["status"] == "preparing", page
            await service.process_pending_timeline_preparations(batch_size=1, max_jobs=1)
            async with history_factory() as db:
                count = await db.scalar(select(func.count()).select_from(TimelineCheckpoint).where(TimelineCheckpoint.generation_id == uuid.UUID(generation["id"])))
                assert count <= 3, "Preparing a long prefix retained one full-board state per event"
        pytest.fail("Evicted history preparation never became ready again")

    early = await prepare_window(4)
    await prepare_window(12)
    async with history_factory() as db:
        old_anchor = await db.scalar(select(TimelineCheckpoint).where(TimelineCheckpoint.generation_id == uuid.UUID(generation["id"]), TimelineCheckpoint.through_seq == 3))
        assert old_anchor is None, "The fixture must exercise real checkpoint eviction"
    revisited = await prepare_window(4)
    assert revisited["anchor"]["state"] == early["anchor"]["state"]
    assert revisited["anchor"]["state"]["columns"][0]["name"] == "Known from the beginning"
    assert revisited["anchor"]["through_seq"] == "3"
