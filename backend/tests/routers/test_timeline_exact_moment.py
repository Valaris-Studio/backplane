# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, func, select, update

from app.core.auth import get_current_user
from app.database import get_db
from app.main import create_app
from app.models.kanban.board import Board
from app.models.timeline import (
    TimelineCheckpoint,
    TimelineGeneration,
    TimelinePreparation,
)
from app.models.workspace import WorkspaceMember
from tests.routers.test_timeline_generations import (
    activity,
    establish,
    timeline_path,
)
from tests.routers.test_timeline_generations import history_factory  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.usefixtures("history_factory")]
FIRST = 2**53 + 10_000


@pytest_asyncio.fixture
async def exact_client(history_factory, test_user):  # noqa: F811 — imported pytest fixture injection
    app = create_app()

    async def request_db():
        # Successful window requests must actually commit any queued work. A
        # fresh read session below distinguishes durable effects from flushes.
        async with history_factory() as db:
            yield db
            await db.commit()

    async def identity():
        return test_user

    app.dependency_overrides[get_db] = request_db
    app.dependency_overrides[get_current_user] = identity
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as client:
        yield client


async def work_counts(factory, generation_id):
    identity = uuid.UUID(generation_id)
    async with factory() as db:
        return {
            "checkpoints": await db.scalar(
                select(func.count()).select_from(TimelineCheckpoint).where(
                    TimelineCheckpoint.generation_id == identity
                )
            ),
            "preparations": await db.scalar(
                select(func.count()).select_from(TimelinePreparation).where(
                    TimelinePreparation.generation_id == identity
                )
            ),
        }


def receipt(case, response, before, after):
    body = response.json()
    print("A05_EXACT_SERVER_RECEIPT " + json.dumps({
        "case": case,
        "status": response.status_code,
        "error_code": body.get("error_code"),
        "state": body.get("status"),
        "returned_sequences": [row["seq"] for row in body.get("events", [])],
        "before": before,
        "after": after,
    }, sort_keys=True))


async def test_exact_visible_sequence_preserves_string_identity_and_neighbors(
    exact_client, db_session, test_board, test_workspace, test_user, history_factory  # noqa: F811 — imported pytest fixture injection
):
    rows = [
        activity(
            test_board, test_workspace, test_user,
            seq=FIRST + offset, summary=f"exact visible {offset}",
        )
        for offset in (0, 2, 4)
    ]
    db_session.add_all(rows)
    await db_session.commit()
    generation = await establish(exact_client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"
    params = {"at_seq": str(FIRST + 2), "limit": 1}
    approximate = await exact_client.get(path, params=params)
    assert approximate.status_code == 200, approximate.text
    response = await exact_client.get(path, params={**params, "exact": "true"})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body == approximate.json()
    assert [row["id"] for row in body["events"]] == [str(rows[1].id)]
    assert [row["seq"] for row in body["events"]] == [str(FIRST + 2)]
    assert body["anchor"]["through_seq"] == str(FIRST)
    assert body["window"]["first_seq"] == body["window"]["last_seq"] == str(FIRST + 2)
    assert body["window"]["previous_cursor"]
    assert body["window"]["next_cursor"]
    assert await work_counts(history_factory, generation["id"]) == {
        "checkpoints": 0, "preparations": 0
    }


@pytest.mark.parametrize("target_offset,expected_offset", [(1, 2), (9, 4)])
async def test_omitted_exact_and_false_preserve_approximate_gap_and_head_lookup(
    exact_client, db_session, test_board, test_workspace, test_user,
    target_offset, expected_offset,
):
    db_session.add_all([
        activity(
            test_board, test_workspace, test_user,
            seq=FIRST + offset, summary=f"legacy neighbor {offset}",
        )
        for offset in (0, 2, 4)
    ])
    await db_session.commit()
    generation = await establish(exact_client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"
    params = {"at_seq": str(FIRST + target_offset), "limit": 1}
    omitted = await exact_client.get(path, params=params)
    explicit_false = await exact_client.get(path, params={**params, "exact": "false"})
    assert omitted.status_code == explicit_false.status_code == 200
    assert omitted.json() == explicit_false.json()
    assert [row["seq"] for row in omitted.json()["events"]] == [str(FIRST + expected_offset)]


@pytest.mark.parametrize("missing", ["before-first", "gap", "beyond-head", "other-board", "empty"])
async def test_exact_miss_is_uniform_and_does_not_persist_anchor_or_preparation(
    exact_client, db_session, test_board, test_workspace, test_user, history_factory,  # noqa: F811 — imported pytest fixture injection
    missing,
):
    # There are 201 preceding visible events for the expensive miss shapes.
    # The real inline budget is 200; no constant or replay routine is patched.
    if missing != "empty":
        db_session.add_all([
            activity(
                test_board, test_workspace, test_user,
                seq=FIRST + offset, summary=f"retained prefix {offset}",
            )
            for offset in (*range(201), 204)
        ])
    target = FIRST + 203
    if missing == "before-first":
        target = FIRST - 1
    elif missing == "beyond-head":
        target = FIRST + 205
    elif missing == "other-board":
        other = Board(
            workspace_id=test_workspace.id, name="Other exact board",
            slug="other-exact-board", created_by=test_user.id,
        )
        db_session.add(other)
        await db_session.flush()
        db_session.add(activity(
            other, test_workspace, test_user, seq=target,
            summary="foreign-board-synthetic-marker",
        ))
    await db_session.commit()
    generation = await establish(exact_client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"
    assert generation["event_count"] == ("0" if missing == "empty" else "202")
    if missing != "empty":
        control = await exact_client.get(path, params={"at_seq": str(FIRST), "limit": 1})
        assert control.status_code == 200, control.text
        assert [row["seq"] for row in control.json()["events"]] == [str(FIRST)]
    else:
        control = await exact_client.get(path)
        assert control.status_code == 200, control.text
        assert control.json()["events"] == []
    before = await work_counts(history_factory, generation["id"])
    assert before == {"checkpoints": 0, "preparations": 0}
    response = await exact_client.get(
        path, params={"at_seq": str(target), "exact": "true", "limit": 1}
    )
    after = await work_counts(history_factory, generation["id"])
    receipt(missing, response, before, after)
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "timeline_event_not_found"
    assert "events" not in response.json()
    assert "foreign-board-synthetic-marker" not in response.text
    assert after == before, "An unavailable exact moment must not enqueue replay work"


@pytest.mark.parametrize("selector", ["none", "time", "cursor", "seq-and-time", "seq-and-cursor"])
async def test_exact_requires_only_at_seq_and_preserves_ordinary_selectors(
    exact_client, db_session, test_board, test_workspace, test_user, history_factory,  # noqa: F811 — imported pytest fixture injection
    selector,
):
    db_session.add_all([
        activity(test_board, test_workspace, test_user, seq=seq, summary=f"selector {seq}")
        for seq in (10, 11, 12)
    ])
    await db_session.commit()
    generation = await establish(exact_client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"
    first = await exact_client.get(path, params={"at_seq": "10", "limit": 1})
    assert first.status_code == 200, first.text
    cursor = first.json()["window"]["next_cursor"]
    assert cursor
    params = {"exact": "true", "limit": 1}
    if selector in ("time", "seq-and-time"):
        params["at_time"] = "2026-10-08T00:00:00Z"
    if selector in ("cursor", "seq-and-cursor"):
        params["cursor"] = cursor
    if selector in ("seq-and-time", "seq-and-cursor"):
        params["at_seq"] = "11"
    if selector in ("none", "time", "cursor"):
        legacy = await exact_client.get(path, params={key: value for key, value in params.items() if key != "exact"})
        assert legacy.status_code == 200, legacy.text
        assert legacy.json()["events"]
    before = await work_counts(history_factory, generation["id"])
    response = await exact_client.get(path, params=params)
    after = await work_counts(history_factory, generation["id"])
    receipt(f"invalid-{selector}", response, before, after)
    assert response.status_code == 422, response.text
    assert after == before


async def test_expiry_precedes_exact_event_existence_without_creating_work(
    exact_client, db_session, test_board, test_workspace, test_user, history_factory  # noqa: F811 — imported pytest fixture injection
):
    db_session.add(activity(test_board, test_workspace, test_user, seq=10, summary="expiry control"))
    await db_session.commit()
    generation = await establish(exact_client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"
    allowed = await exact_client.get(path, params={"at_seq": "10", "exact": "true"})
    assert allowed.status_code == 200, allowed.text
    async with history_factory.begin() as db:
        await db.execute(update(TimelineGeneration).where(
            TimelineGeneration.id == uuid.UUID(generation["id"])
        ).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    before = await work_counts(history_factory, generation["id"])
    for at_seq in ("10", "11"):
        response = await exact_client.get(path, params={"at_seq": at_seq, "exact": "true"})
        assert response.status_code == 410, response.text
        assert response.json()["error_code"] == "timeline_generation_expired"
    assert await work_counts(history_factory, generation["id"]) == before


async def test_current_membership_revocation_precedes_event_and_expiry_information(
    exact_client, db_session, test_board, test_workspace, test_user, history_factory  # noqa: F811 — imported pytest fixture injection
):
    db_session.add(activity(test_board, test_workspace, test_user, seq=10, summary="revocation control"))
    await db_session.commit()
    generation = await establish(exact_client, timeline_path(test_board))
    path = f"{timeline_path(test_board)}/generations/{generation['id']}/window"
    allowed = await exact_client.get(path, params={"at_seq": "10", "exact": "true"})
    assert allowed.status_code == 200, allowed.text
    before = await work_counts(history_factory, generation["id"])
    async with history_factory.begin() as db:
        await db.execute(delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == test_workspace.id,
            WorkspaceMember.user_id == test_user.id,
        ))
    for at_seq in ("10", "11"):
        response = await exact_client.get(path, params={"at_seq": at_seq, "exact": "true"})
        assert response.status_code == 403, response.text
        assert response.json()["error_code"] != "timeline_event_not_found"
    async with history_factory.begin() as db:
        await db.execute(update(TimelineGeneration).where(
            TimelineGeneration.id == uuid.UUID(generation["id"])
        ).values(expires_at=datetime.now(timezone.utc) - timedelta(seconds=1)))
    expired = await exact_client.get(path, params={"at_seq": "11", "exact": "true"})
    assert expired.status_code == 403, expired.text
    assert expired.json()["error_code"] != "timeline_generation_expired"
    assert await work_counts(history_factory, generation["id"]) == before
