# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.database import get_db
from app.main import create_app
from tests.session_rows import add_installation, add_session
from tests.test_owner_session_overview import HOUR, SESSIONS, ids, page


async def sessions_around_cutoff(db, owner, workspace):
    cutoff = datetime(2026, 10, 18, 12, tzinfo=timezone.utc)
    installation = await add_installation(db, owner)
    sessions = []
    for minutes in (-1, 0, 1):
        session = await add_session(db, installation, workspace, started=HOUR)
        session.started_at = cutoff - HOUR
        session.last_event_at = cutoff + timedelta(minutes=minutes)
        sessions.append(session)
    await db.flush()
    return cutoff, sessions


@pytest.mark.parametrize("offset_hours", [5, -4])
async def test_since_offset_matches_utc_before_global_paging(
    client, db_session, test_user, test_workspace, offset_hours
):
    cutoff, sessions = await sessions_around_cutoff(
        db_session, test_user, test_workspace
    )
    expected = [str(session.id) for session in reversed(sessions[1:])]
    utc_since = cutoff.isoformat()
    shifted_since = cutoff.astimezone(
        timezone(timedelta(hours=offset_hours))
    ).isoformat()

    control = await page(client, since=utc_since)
    assert ids(control["items"]) == expected
    shifted = await page(client, since=shifted_since)
    assert ids(shifted["items"]) == expected

    first = await page(client, since=utc_since, limit=1)
    assert ids(first["items"]) == expected[:1]
    assert first["next_cursor"] is not None
    # The cursor binds effective filters: changing only the timezone notation
    # must not change the instant, reset pagination, or duplicate the first row.
    second = await page(
        client, since=shifted_since, limit=1, cursor=first["next_cursor"]
    )
    assert ids(second["items"]) == expected[1:]
    assert second["next_cursor"] is None


@pytest.mark.parametrize(
    ("since", "includes_sessions"),
    [
        ("0001-01-01T00:00:00+00:00", True),
        ("9999-12-31T23:59:59.999999+00:00", False),
    ],
)
async def test_since_accepts_representable_utc_bounds_without_clock_thresholds(
    client, db_session, test_user, test_workspace, since, includes_sessions
):
    _, sessions = await sessions_around_cutoff(db_session, test_user, test_workspace)
    result = await page(client, since=since)
    expected = [str(session.id) for session in reversed(sessions)]
    assert ids(result["items"]) == (expected if includes_sessions else [])


@pytest.mark.parametrize(
    "since",
    [
        "0001-01-01T00:20:00+01:00",
        "9999-12-31T23:59:59.999999-14:00",
        "not-a-date-private-marker",
    ],
)
async def test_since_without_representable_utc_instant_is_private_validation_error(
    db_session, test_user, test_workspace, since
):
    await sessions_around_cutoff(db_session, test_user, test_workspace)
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app, raise_app_exceptions=False),
        base_url="http://test",
        headers={"X-User-Email": test_user.email},
    ) as observer:
        response = await observer.get(SESSIONS, params={"since": since})
    assert (response.status_code, response.headers.get("cache-control")) == (
        422,
        "no-store",
    ), response.text
    assert since not in response.text
    assert isinstance(response.json()["detail"], str)
