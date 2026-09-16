# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories.activity import ActivityRepository


def _activity(workspace_id: uuid.UUID, actor_id: uuid.UUID, when: datetime) -> Activity:
    return Activity(
        workspace_id=workspace_id,
        actor_id=actor_id,
        entity_type=ActivityEntityType.board,
        entity_id=uuid.uuid4(),
        action=ActivityAction.created,
        summary=f"Activity at {when.isoformat()}",
        created_at=when,
    )


async def test_daily_counts_groups_by_calendar_day(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    repo = ActivityRepository(db_session)
    today = date(2026, 8, 14)

    # 2 on today, 1 three days back, none in between.
    for hour in (1, 20):
        db_session.add(
            _activity(test_workspace.id, test_user.id, datetime(2026, 8, 14, hour, 30))
        )
    db_session.add(
        _activity(test_workspace.id, test_user.id, datetime(2026, 8, 11, 9, 0))
    )
    await db_session.flush()

    buckets = await repo.daily_counts_by_workspace(test_workspace.id, today, days=7)

    assert len(buckets) == 7
    # Oldest first, one entry per day, no gaps.
    assert [bucket_date for bucket_date, _ in buckets] == [
        today - timedelta(days=offset) for offset in range(6, -1, -1)
    ]
    counts_by_day = dict(buckets)
    assert counts_by_day[today] == 2
    assert counts_by_day[date(2026, 8, 11)] == 1
    assert counts_by_day[date(2026, 8, 12)] == 0


async def test_daily_counts_excludes_activity_older_than_the_window(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """The day exactly one window-length back is OUTSIDE a 7-day window that
    already includes today — the sharp edge of the bucket range."""
    repo = ActivityRepository(db_session)
    today = date(2026, 8, 14)

    # 2026-08-08 is the last hour of the oldest included day; 2026-08-07 is out.
    db_session.add(
        _activity(test_workspace.id, test_user.id, datetime(2026, 8, 8, 23, 59))
    )
    db_session.add(
        _activity(test_workspace.id, test_user.id, datetime(2026, 8, 7, 23, 59))
    )
    await db_session.flush()

    buckets = await repo.daily_counts_by_workspace(test_workspace.id, today, days=7)

    counts_by_day = dict(buckets)
    assert counts_by_day[date(2026, 8, 8)] == 1
    assert date(2026, 8, 7) not in counts_by_day
    assert sum(counts_by_day.values()) == 1


async def test_daily_counts_ignores_other_workspaces(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    repo = ActivityRepository(db_session)
    today = date(2026, 8, 14)

    other = Workspace(name="Other", slug="other-ws", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()

    db_session.add(
        _activity(test_workspace.id, test_user.id, datetime(2026, 8, 14, 10, 0))
    )
    db_session.add(_activity(other.id, test_user.id, datetime(2026, 8, 14, 10, 0)))
    await db_session.flush()

    buckets = await repo.daily_counts_by_workspace(test_workspace.id, today, days=7)

    assert dict(buckets)[today] == 1


async def test_daily_counts_empty_workspace_yields_all_zero_buckets(
    db_session: AsyncSession,
    test_workspace: Workspace,
):
    repo = ActivityRepository(db_session)
    today = date(2026, 8, 14)

    buckets = await repo.daily_counts_by_workspace(test_workspace.id, today, days=30)

    assert len(buckets) == 30
    assert all(count == 0 for _, count in buckets)
