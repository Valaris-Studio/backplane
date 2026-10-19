# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Independent reviewer reproductions for the frozen A02 candidate."""

import base64
import json
from datetime import datetime, timedelta, timezone

import pytest
from httpx import ASGITransport, AsyncClient

from app.database import get_db
from app.main import create_app
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.notes.note import Note
from app.models.workspace import WorkspaceMember
from tests.session_rows import add_installation, add_link, add_session
from tests.test_owner_session_overview import (
    HOUR,
    MINUTE,
    OVERVIEW,
    SESSIONS,
    ids,
    page,
    workspace_for,
)


def _rewrite_cursor_clock(cursor: str, evaluated_at: str) -> str:
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    # [version, binding, evaluated_at, key, row_id]: the binding covers neither
    # the clock nor the key, so it stays valid after this edit.
    decoded[2] = evaluated_at
    return base64.urlsafe_b64encode(json.dumps(decoded).encode()).decode().rstrip("=")


@pytest.mark.parametrize(
    "evaluated_at",
    [
        # Each underflows one of the thresholds the page derives from its clock.
        "0001-01-01T00:00:00+00:00",
        "0001-01-01T23:59:59+00:00",
        "0001-01-01T00:20:00+01:00",
        "0001-01-01T00:00:00",
        "0001-01-01",
        # Control: already rejected while decoding.
        "not-a-date",
    ],
)
async def test_cursor_with_underflowing_clock_is_a_private_validation_error(
    client, db_session, test_user, test_workspace, evaluated_at
):
    laptop = await add_installation(db_session, test_user)
    for index in range(2):
        await add_session(
            db_session, laptop, test_workspace, started=HOUR, last=index * MINUTE
        )
    cursor = (await page(client, limit=1))["next_cursor"]
    tampered = _rewrite_cursor_clock(cursor, evaluated_at)

    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app, raise_app_exceptions=False),
        base_url="http://test",
        headers={"X-User-Email": test_user.email},
    ) as observer:
        response = await observer.get(SESSIONS, params={"cursor": tampered})
    assert (response.status_code, response.headers.get("cache-control")) == (
        422,
        "no-store",
    ), response.text
    assert response.json()["detail"] == "Invalid cursor"
    assert tampered not in response.text and evaluated_at not in response.text


@pytest.mark.parametrize("entity_type", ["note", "card"])
async def test_destination_moved_out_of_reach_is_dropped_while_link_workspace_stays_visible(
    client, db_session, test_user, second_user, test_workspace, test_board, entity_type
):
    unreachable = await workspace_for(db_session, second_user, "not-mine")
    foreign_board = Board(
        workspace_id=unreachable.id,
        name="Foreign board",
        slug="foreign",
        created_by=second_user.id,
    )
    db_session.add(foreign_board)
    await db_session.flush()
    columns = [
        Column(board_id=board.id, name="Todo", position=1024)
        for board in (test_board, foreign_board)
    ]
    db_session.add_all(columns)
    await db_session.flush()
    if entity_type == "note":
        entity = Note(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            title="Was reachable",
            content="body",
            created_by=test_user.id,
        )
    else:
        entity = Card(
            column_id=columns[0].id,
            board_id=test_board.id,
            title="Was reachable",
            created_by=test_user.id,
        )
    db_session.add(entity)
    await db_session.flush()
    laptop = await add_installation(db_session, test_user)
    session = await add_session(db_session, laptop, test_workspace, started=HOUR)
    await add_link(db_session, session, entity, entity_type=entity_type)
    assert (await page(client))["items"][0]["link_count"] == 1

    # The link row still names the accessible session workspace; only the live
    # entity moved. Authorizing against the link's workspace would keep it.
    if entity_type == "note":
        entity.workspace_id = unreachable.id
        entity.board_id = foreign_board.id
    else:
        entity.board_id = foreign_board.id
        entity.column_id = columns[1].id
    await db_session.flush()
    listing = await page(client)
    row = listing["items"][0]
    assert row["link_count"] == 0
    assert row["link_preview"] == []
    assert (await page(client, linked_only=True))["items"] == []
    assert "Was reachable" not in json.dumps(listing)


async def test_filters_naming_a_left_workspace_or_its_board_are_empty_not_forbidden(
    client, db_session, test_user, test_workspace
):
    left = await workspace_for(db_session, test_user, "left-behind")
    left_board = Board(
        workspace_id=left.id, name="Left board", slug="left", created_by=test_user.id
    )
    db_session.add(left_board)
    await db_session.flush()
    laptop = await add_installation(db_session, test_user)
    await add_session(
        db_session, laptop, left, started=HOUR, board_id=left_board.id, title="gone"
    )
    kept = await add_session(db_session, laptop, test_workspace, started=HOUR)
    assert len((await page(client, workspace_id=str(left.id)))["items"]) == 1
    await db_session.execute(
        WorkspaceMember.__table__.delete().where(
            WorkspaceMember.workspace_id == left.id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    for params in (
        {"workspace_id": str(left.id)},
        {"board_id": str(left_board.id)},
        {"q": "Left board"},
        {"q": "gone"},
    ):
        result = await page(client, **params)
        assert result == {"items": [], "next_cursor": None}, params
    assert [row["id"] for row in (await page(client))["items"]] == [str(kept.id)]
    overview = await page(client, OVERVIEW)
    assert [row["id"] for row in overview["active"] + overview["recent"]] == [
        str(kept.id)
    ]


async def test_board_name_search_matches_each_sessions_own_member_workspace(
    client, db_session, test_user, test_workspace, test_board
):
    other = await workspace_for(db_session, test_user, "board-search")
    needle_board = Board(
        workspace_id=other.id,
        name="Needle board",
        slug="needle",
        created_by=test_user.id,
    )
    db_session.add(needle_board)
    await db_session.flush()
    laptop = await add_installation(db_session, test_user)
    match = await add_session(
        db_session, laptop, other, started=HOUR, board_id=needle_board.id
    )
    await add_session(
        db_session, laptop, test_workspace, started=HOUR, board_id=test_board.id
    )
    result = await page(client, q="needle BOARD")
    assert [row["id"] for row in result["items"]] == [str(match.id)]
    assert result["items"][0]["board_name"] == "Needle board"


async def test_overview_groups_stay_disjoint_when_a_session_ends_between_statements(
    client, db_session, test_user, test_workspace, monkeypatch
):
    from app.repositories.agent_session import AgentSessionRepository

    laptop = await add_installation(db_session, test_user)
    ending = await add_session(db_session, laptop, test_workspace, started=HOUR)
    original = AgentSessionRepository.list_owner_metadata
    calls = []

    async def end_after_first_group(self, *args, **kwargs):
        rows = await original(self, *args, **kwargs)
        calls.append(kwargs["states"])
        if len(calls) == 1:
            # PostgreSQL READ COMMITTED gives each statement a fresh snapshot;
            # ingest committing this session's end between them looks like this.
            ending.ended_at = ending.last_event_at
            ending.status = "ended"
            await db_session.flush()
        return rows

    monkeypatch.setattr(
        AgentSessionRepository, "list_owner_metadata", end_after_first_group
    )
    overview = await page(client, OVERVIEW)
    assert calls[0] == ["active"]
    active = {row["id"] for row in overview["active"]}
    recent = {row["id"] for row in overview["recent"]}
    assert not active & recent, overview


CURSOR_CLOCK, CURSOR_KEY = 2, 3


def _cursor_field(cursor: str, position: int) -> str:
    return json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))[
        position
    ]


def _rewrite_cursor_field(cursor: str, position: int, value: str) -> str:
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    decoded[position] = value
    return base64.urlsafe_b64encode(json.dumps(decoded).encode()).decode().rstrip("=")


async def _two_page_cursor(client, db_session, owner, workspace) -> str:
    laptop = await add_installation(db_session, owner)
    for index in range(2):
        await add_session(
            db_session, laptop, workspace, started=HOUR, last=index * MINUTE
        )
    return (await page(client, limit=1))["next_cursor"]


async def _observe_continuation(db_session, owner, cursor):
    app = create_app()

    async def database():
        yield db_session

    app.dependency_overrides[get_db] = database
    async with AsyncClient(
        transport=ASGITransport(app, raise_app_exceptions=False),
        base_url="http://test",
        headers={"X-User-Email": owner.email},
    ) as observer:
        return await observer.get(SESSIONS, params={"cursor": cursor})


@pytest.mark.parametrize(
    ("position", "instant"),
    [
        # Valid ISO text whose UTC instant falls outside datetime's range.
        (CURSOR_CLOCK, "9999-12-31T23:59:59.999999-14:00"),
        (CURSOR_KEY, "0001-01-01T00:20:00+01:00"),
        (CURSOR_KEY, "9999-12-31T23:59:59.999999-14:00"),
    ],
)
async def test_cursor_instant_without_a_utc_equivalent_is_a_private_validation_error(
    client, db_session, test_user, test_workspace, position, instant
):
    cursor = await _two_page_cursor(client, db_session, test_user, test_workspace)
    tampered = _rewrite_cursor_field(cursor, position, instant)
    response = await _observe_continuation(db_session, test_user, tampered)
    assert (response.status_code, response.headers.get("cache-control")) == (
        422,
        "no-store",
    ), response.text
    assert response.json()["detail"] == "Invalid cursor"
    assert tampered not in response.text and instant not in response.text


async def test_cursor_clock_is_bounded_only_by_the_longest_state_threshold(
    client, db_session, test_user, test_workspace
):
    cursor = await _two_page_cursor(client, db_session, test_user, test_workspace)
    outcomes = {}
    for evaluated_at in (
        "0001-01-01T23:59:59.999999+00:00",
        "0001-01-02T00:00:00+00:00",
        "9999-12-31T23:59:59.999999+00:00",
    ):
        tampered = _rewrite_cursor_field(cursor, CURSOR_CLOCK, evaluated_at)
        response = await _observe_continuation(db_session, test_user, tampered)
        outcomes[evaluated_at] = (
            response.status_code,
            response.headers.get("cache-control"),
        )
    # A day of silence is the longest threshold subtracted from the clock. No
    # maximum cursor age exists, so any representable later clock still pages.
    assert outcomes == {
        "0001-01-01T23:59:59.999999+00:00": (422, "no-store"),
        "0001-01-02T00:00:00+00:00": (200, "no-store"),
        "9999-12-31T23:59:59.999999+00:00": (200, "no-store"),
    }


async def test_offset_cursor_instants_continue_exactly_like_their_utc_form(
    client, db_session, test_user, test_workspace
):
    laptop = await add_installation(db_session, test_user)
    for index in range(3):
        await add_session(
            db_session, laptop, test_workspace, started=HOUR, last=index * MINUTE
        )
    cursor = (await page(client, limit=1))["next_cursor"]
    expected = await page(client, cursor=cursor)
    assert len(expected["items"]) == 2
    assert {row["display_state"] for row in expected["items"]} == {"active"}

    # The same two instants at another offset. SQLite binds wall-clock fields
    # only, so an unnormalized instant would compare five hours later.
    shifted = cursor
    for position in (CURSOR_CLOCK, CURSOR_KEY):
        instant = datetime.fromisoformat(_cursor_field(cursor, position))
        shifted = _rewrite_cursor_field(
            shifted,
            position,
            instant.astimezone(timezone(timedelta(hours=5))).isoformat(),
        )
    assert await page(client, cursor=shifted) == expected


async def test_overview_recent_excludes_the_whole_active_group_and_keeps_its_more_flag(
    client, db_session, test_user, test_workspace, monkeypatch
):
    from app.repositories.agent_session import AgentSessionRepository

    laptop = await add_installation(db_session, test_user)
    active_roots = [
        await add_session(
            db_session, laptop, test_workspace, started=HOUR, last=index * MINUTE
        )
        for index in range(7)
    ]
    idle_roots = [
        await add_session(
            db_session,
            laptop,
            test_workspace,
            started=2 * HOUR,
            last=(20 + index) * MINUTE,
        )
        for index in range(7)
    ]
    lookahead = active_roots[-1]
    original = AgentSessionRepository.list_owner_metadata
    calls = []

    async def end_lookahead_after_first_group(self, *args, **kwargs):
        rows = await original(self, *args, **kwargs)
        calls.append(kwargs["states"])
        if len(calls) == 1:
            lookahead.ended_at = lookahead.last_event_at
            lookahead.status = "ended"
            await db_session.flush()
        return rows

    monkeypatch.setattr(
        AgentSessionRepository, "list_owner_metadata", end_lookahead_after_first_group
    )
    overview = await page(client, OVERVIEW)
    assert calls[0] == ["active"]
    assert ids(overview["active"]) == [str(row.id) for row in active_roots[:6]]
    assert overview["active_more"] is True
    # The unshown seventh active row already backs active_more. Listing it again
    # counts it twice; dropping it after fetching leaves recent_more blind to
    # idle_roots[6].
    assert ids(overview["recent"]) == [str(row.id) for row in idle_roots[:6]]
    assert overview["recent_more"] is True
