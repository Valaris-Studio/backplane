# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DK-WEB B6: period totals for My sessions. Wall time is the union of the
sessions' spans, and the two cost bases are never added together."""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event as sa_event

from app.models.workspace import WorkspaceMember, WorkspaceRole
from tests.session_rows import add_installation, add_session
from tests.test_agent_sessions import as_user

SUMMARY = "/api/workspaces/default/sessions/summary"
MIN = timedelta(minutes=1)
HOUR = timedelta(hours=1)


@pytest.fixture
async def laptop(db_session, test_user):
    return await add_installation(db_session, test_user)


async def summary(client, query=""):
    response = await client.get(SUMMARY + query)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def since(delta: timedelta) -> str:
    return "?since=" + (datetime.now(timezone.utc) - delta).isoformat().replace(
        "+", "%2B"
    )


async def test_empty_period_is_zero_not_missing(client, test_workspace):
    body = await summary(client)
    assert body == {
        "session_count": 0,
        "live_count": 0,
        "wall_duration_seconds": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_creation_tokens": 0,
        "reasoning_tokens": 0,
        "cost_api_equivalent_usd": None,
        "cost_spend_usd": None,
        "cost_complete": True,
    }


async def test_cost_bases_are_kept_apart_and_never_summed(
    client, db_session, laptop, test_workspace
):
    ws = test_workspace
    for auth_kind, cost in (
        ("api", 1.0),
        ("enterprise", 0.5),
        ("subscription", 2.0),
        ("unknown", 0.25),
        (None, 0.125),
    ):
        await add_session(
            db_session,
            laptop,
            ws,
            started=HOUR,
            auth_kind=auth_kind,
            cost_usd=cost,
            input_tokens=100,
            output_tokens=10,
            cache_read_tokens=1000,
            cache_creation_tokens=5,
            reasoning_tokens=3,
        )
    body = await summary(client)
    assert body["cost_spend_usd"] == pytest.approx(1.5)
    assert body["cost_api_equivalent_usd"] == pytest.approx(2.375)
    assert body["session_count"] == 5
    assert (body["input_tokens"], body["output_tokens"]) == (500, 50)
    assert (body["cache_read_tokens"], body["cache_creation_tokens"]) == (5000, 25)
    assert body["reasoning_tokens"] == 15
    assert body["cost_complete"] is True


async def test_a_basis_without_any_cost_is_null(
    client, db_session, laptop, test_workspace
):
    await add_session(
        db_session, laptop, test_workspace, started=HOUR, auth_kind="api", cost_usd=3
    )
    body = await summary(client)
    assert body["cost_spend_usd"] == 3
    assert body["cost_api_equivalent_usd"] is None


async def test_cost_is_incomplete_only_when_used_tokens_have_no_price(
    client, db_session, laptop, test_workspace
):
    ws = test_workspace
    # No usage at all: nothing is missing.
    await add_session(db_session, laptop, ws, started=HOUR)
    assert (await summary(client))["cost_complete"] is True
    unpriced = await add_session(
        db_session, laptop, ws, started=HOUR, input_tokens=50, cost_usd=1
    )
    unpriced.unpriced_usage_count = 1
    await db_session.flush()
    assert (await summary(client))["cost_complete"] is False
    unpriced.unpriced_usage_count = 0
    await add_session(db_session, laptop, ws, started=HOUR, output_tokens=9)
    assert (await summary(client))["cost_complete"] is False


async def test_wall_time_is_the_union_of_spans_clipped_to_the_period(
    client, db_session, laptop, test_workspace
):
    ws = test_workspace
    parent = await add_session(db_session, laptop, ws, started=5 * HOUR, last=4 * HOUR)
    await add_session(
        db_session,
        laptop,
        ws,
        started=5 * HOUR - 10 * MIN,
        last=5 * HOUR - 30 * MIN,
        parent_session_id=parent.id,
    )
    await add_session(db_session, laptop, ws, started=2 * HOUR, last=90 * MIN)
    # Started before the period, still running inside it: only the part
    # inside the period counts.
    await add_session(db_session, laptop, ws, started=30 * HOUR, last=20 * HOUR)

    body = await summary(client, since(24 * HOUR))
    assert body["session_count"] == 4
    assert body["wall_duration_seconds"] == pytest.approx(3600 + 1800 + 4 * 3600, abs=2)


async def test_filters_since_board_harness_and_root_only(
    client, db_session, laptop, test_workspace, test_board
):
    ws = test_workspace
    parent = await add_session(
        db_session, laptop, ws, started=HOUR, board_id=test_board.id, input_tokens=1
    )
    await add_session(
        db_session,
        laptop,
        ws,
        started=MIN,
        parent_session_id=parent.id,
        parent_native_session_id=parent.native_session_id,
        input_tokens=2,
    )
    await add_session(
        db_session, laptop, ws, started=HOUR, harness="codex_cli", input_tokens=4
    )
    await add_session(
        db_session,
        laptop,
        ws,
        started=10 * 24 * HOUR,
        last=9 * 24 * HOUR,
        input_tokens=8,
    )
    assert (await summary(client))["input_tokens"] == 15
    assert (await summary(client, since(24 * HOUR)))["input_tokens"] == 7
    assert (await summary(client, f"?board_id={test_board.id}"))["input_tokens"] == 1
    assert (await summary(client, "?harness=codex_cli"))["input_tokens"] == 4
    assert (await summary(client, "?root_only=true"))["input_tokens"] == 13
    assert (await client.get(SUMMARY + "?harness=Not-A-Harness")).status_code == 422


async def test_live_count_is_display_state_active(
    client, db_session, test_user, laptop, test_workspace
):
    paused = await add_installation(db_session, test_user, paused=True)
    ws = test_workspace
    await add_session(db_session, laptop, ws, started=HOUR, last=MIN)
    await add_session(db_session, laptop, ws, started=HOUR, last=2 * MIN)
    await add_session(db_session, laptop, ws, started=HOUR, last=20 * MIN)  # idle
    await add_session(db_session, paused, ws, started=HOUR, last=MIN)  # paused
    body = await summary(client)
    assert (body["session_count"], body["live_count"]) == (4, 2)


async def test_summary_is_the_owners_alone(
    client, agent_client, db_session, test_workspace, second_user
):
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    theirs = await add_installation(db_session, second_user)
    await add_session(
        db_session, theirs, test_workspace, started=HOUR, input_tokens=7, cost_usd=1
    )
    assert (await summary(client))["session_count"] == 0
    async with as_user(db_session, second_user) as other:
        assert (await summary(other))["input_tokens"] == 7
    assert (await agent_client.get(SUMMARY)).status_code == 403


async def test_summary_is_a_fixed_number_of_statements(
    client, db_session, laptop, test_workspace
):
    count = 0

    def _count(*_):
        nonlocal count
        count += 1

    async def statements():
        nonlocal count
        count = 0
        engine = db_session.get_bind()
        sa_event.listen(engine, "before_cursor_execute", _count)
        try:
            await summary(client)
        finally:
            sa_event.remove(engine, "before_cursor_execute", _count)
        return count

    await add_session(db_session, laptop, test_workspace, started=HOUR)
    small = await statements()
    for _ in range(30):
        await add_session(db_session, laptop, test_workspace, started=HOUR)
    assert await statements() == small
    assert small <= 6
