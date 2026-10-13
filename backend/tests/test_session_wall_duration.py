# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Wall time on linked-work rollups: overlapping sessions are counted once (1d52204b)."""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select, update

from app.models.agent_session import AgentSession, SessionWorkLink
from app.services.agent_session import union_seconds
from tests.test_agent_sessions import enroll, record, upload
from tests.test_session_lifecycle import OPEN_EVENTS, device_client, fresh, with_ids

__all__ = ["device_client"]  # fixture re-export

UTC = timezone.utc


def at(hour: int, minute: int = 0, *, tz=UTC) -> datetime:
    return datetime(2026, 10, 5, hour, minute, tzinfo=tz)


@pytest.mark.parametrize(
    "intervals,expected",
    [
        ([], 0),
        ([(at(14), at(15))], 3600),
        # parent 14:00-15:00 with a subagent 14:10-14:30: the bug reported 4800
        ([(at(14), at(15)), (at(14, 10), at(14, 30))], 3600),
        ([(at(14), at(14, 10)), (at(15), at(15, 20))], 1800),
        ([(at(14), at(14, 30)), (at(14, 30), at(15))], 3600),
        ([(at(14), at(15)), (at(14, 10), at(14, 20)), (at(14, 40), at(14, 50))], 3600),
        ([(at(14), at(14, 30)), (at(14, 20), at(14, 50))], 3000),
        ([(at(14, 20), at(14, 50)), (at(14), at(14, 30))], 3000),
        ([(at(14), at(14)), (at(15), at(15, 10))], 600),
        ([(at(14), at(14))], 0),
        ([(at(14), at(15)), (at(14), at(15))], 3600),
        ([(at(15), at(14))], 0),
    ],
    ids=[
        "empty",
        "single",
        "parent-with-nested-child",
        "disjoint",
        "touching",
        "two-nested-children",
        "partial-overlap",
        "partial-overlap-unsorted",
        "zero-length-plus-other",
        "zero-length-alone",
        "identical",
        "reversed-clock-skew",
    ],
)
def test_union_seconds(intervals, expected):
    assert union_seconds(intervals) == pytest.approx(expected)


def test_union_seconds_treats_naive_timestamps_as_utc():
    naive_parent = (at(14).replace(tzinfo=None), at(15).replace(tzinfo=None))
    aware_child = (at(14, 10), at(14, 30))
    assert union_seconds([naive_parent, aware_child]) == pytest.approx(3600)


def test_union_seconds_compares_instants_across_offsets():
    plus_two = timezone(timedelta(hours=2))
    # 16:10+02:00 is 14:10Z: nested inside the UTC parent, not disjoint from it
    child = (at(16, 10, tz=plus_two), at(16, 30, tz=plus_two))
    assert union_seconds([(at(14), at(15)), child]) == pytest.approx(3600)


async def _set_span(db_session, native: str, start: datetime, end: datetime):
    await db_session.execute(
        update(AgentSession)
        .where(AgentSession.native_session_id == native)
        .values(started_at=start, last_event_at=end)
    )


async def test_card_rollup_counts_a_subagent_inside_its_parent_once(
    client, device_client, db_session, test_workspace, test_board, test_card
):
    token, mapping_id = await enroll(client, test_workspace, test_board)
    # OPEN_EVENTS has no session.ended: both sessions are still running
    root = record(with_ids(fresh(OPEN_EVENTS), "root"), mapping_id, session="root")
    child = record(with_ids(fresh(OPEN_EVENTS), "child"), mapping_id, session="child")
    child["parent_native_session_id"] = "root"
    await upload(device_client, token, [root, child])

    day = datetime.now(UTC).replace(hour=14, minute=0, second=0, microsecond=0)
    await _set_span(db_session, "root", day, day + timedelta(hours=1))
    await _set_span(
        db_session, "child", day + timedelta(minutes=10), day + timedelta(minutes=30)
    )
    for session in await db_session.scalars(select(AgentSession)):
        assert session.ended_at is None
        db_session.add(
            SessionWorkLink(
                session_id=session.id,
                workspace_id=test_workspace.id,
                entity_type="card",
                entity_id=test_card.id,
                board_id=test_board.id,
                relation="changed",
                first_seen_at=day,
                last_seen_at=day + timedelta(minutes=5),
                id=uuid.uuid4(),
            )
        )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
    )
    assert response.status_code == 200
    summary = response.json()["summary"]
    assert summary["session_count"] == 2
    assert summary["wall_duration_seconds"] == pytest.approx(3600)
    assert summary["total_duration_seconds"] == pytest.approx(4800)


async def test_empty_rollup_has_zero_wall_time(client, test_board, test_card):
    summary = (
        await client.get(
            f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions"
        )
    ).json()["summary"]
    assert summary["wall_duration_seconds"] == 0
