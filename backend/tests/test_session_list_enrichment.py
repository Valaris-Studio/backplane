# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DK-WEB B5: the session list searches, filters on display state and linked
work, sorts with per-sort keyset cursors, and carries subagent and linked
work previews without a query per row."""

import base64
import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, delete, inspect
from sqlalchemy import event as sa_event

from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.workspace import WorkspaceMember, WorkspaceRole
from tests.session_rows import add_installation, add_link, add_mapping, add_session
from tests.test_agent_sessions import as_user
from tests.test_session_cost_migration import VERSIONS, _at_109, _load

SESSIONS = "/api/workspaces/default/sessions"
MIN = timedelta(minutes=1)
HOUR = timedelta(hours=1)


async def listed(client, query=""):
    response = await client.get(SESSIONS + query)
    assert response.status_code == 200, response.text
    return response.json()


async def all_pages(client, query, limit=2):
    ids, cursor = [], None
    while True:
        page = await listed(
            client, f"?{query}&limit={limit}" + (f"&cursor={cursor}" if cursor else "")
        )
        ids += [item["id"] for item in page["items"]]
        cursor = page["next_cursor"]
        if cursor is None:
            return ids


@pytest.fixture
async def laptop(db_session, test_user):
    return await add_installation(db_session, test_user)


async def card_on(db_session, board, column, user, title):
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=1024.0,
        created_by=user.id,
    )
    db_session.add(card)
    await db_session.flush()
    return card


# --- search ------------------------------------------------------------------


async def test_q_searches_title_repository_branch_and_board_name(
    client, db_session, laptop, test_workspace, test_board, test_user
):
    by_title = await add_session(
        db_session, laptop, test_workspace, started=HOUR, title="Fix the Login flow"
    )
    by_repo = await add_session(
        db_session,
        laptop,
        test_workspace,
        started=HOUR,
        repository="github.com/acme/LOGIN-svc",
    )
    by_branch = await add_session(
        db_session, laptop, test_workspace, started=HOUR, branch="feature/login"
    )
    board = Board(
        workspace_id=test_workspace.id,
        name="Login revamp",
        slug="login-revamp",
        created_by=test_user.id,
    )
    db_session.add(board)
    await db_session.flush()
    by_board = await add_session(
        db_session, laptop, test_workspace, started=HOUR, board_id=board.id
    )
    await add_session(
        db_session,
        laptop,
        test_workspace,
        started=HOUR,
        title="Unrelated",
        board_id=test_board.id,
    )

    found = {item["id"] for item in (await listed(client, "?q=login"))["items"]}
    assert found == {str(s.id) for s in (by_title, by_repo, by_branch, by_board)}
    assert len((await listed(client, "?q=%20%20"))["items"]) == 5


async def test_q_treats_like_wildcards_literally(
    client, db_session, laptop, test_workspace
):
    percent = await add_session(
        db_session, laptop, test_workspace, started=HOUR, title="Cut costs 50% now"
    )
    underscore = await add_session(
        db_session, laptop, test_workspace, started=HOUR, title="rename user_id"
    )
    await add_session(
        db_session, laptop, test_workspace, started=HOUR, title="Cut costs 500 now"
    )
    await add_session(
        db_session, laptop, test_workspace, started=HOUR, title="rename userXid"
    )
    await add_session(
        db_session, laptop, test_workspace, started=HOUR, title="back\\slash"
    )

    assert [i["id"] for i in (await listed(client, "?q=50%25"))["items"]] == [
        str(percent.id)
    ]
    assert [i["id"] for i in (await listed(client, "?q=user_id"))["items"]] == [
        str(underscore.id)
    ]
    assert len((await listed(client, "?q=k%5Cs"))["items"]) == 1
    assert (await client.get(SESSIONS + "?q=" + "x" * 101)).status_code == 422


# --- display state -----------------------------------------------------------


async def test_state_filter_matches_each_derived_display_state(
    client, db_session, test_user, laptop, test_workspace
):
    paused_device = await add_installation(db_session, test_user, paused=True)
    no_codex = await add_installation(
        db_session, test_user, enabled_agents=["claude_code"]
    )
    stale_device = await add_installation(
        db_session, test_user, last_seen_at=datetime.now(timezone.utc) - 2 * HOUR
    )
    revoked_device = await add_installation(
        db_session, test_user, revoked_at=datetime.now(timezone.utc)
    )
    off_mapping = await add_mapping(db_session, laptop, test_workspace, enabled=False)
    on_mapping = await add_mapping(db_session, laptop, test_workspace)
    ws = test_workspace

    def ended_at(session):
        return session.last_event_at

    expected = {
        "active": [
            await add_session(db_session, laptop, ws, started=HOUR, last=MIN),
            await add_session(
                db_session, laptop, ws, started=HOUR, last=MIN, mapping_id=on_mapping.id
            ),
            # An end event older than the latest event is not a real end.
            await add_session(
                db_session,
                laptop,
                ws,
                started=HOUR,
                last=MIN,
                ended_at=datetime.now(timezone.utc) - 30 * MIN,
            ),
        ],
        "idle": [
            await add_session(db_session, laptop, ws, started=HOUR, last=20 * MIN)
        ],
        "incomplete": [
            await add_session(
                db_session, laptop, ws, started=3 * HOUR * 24, last=2 * HOUR * 24
            ),
            await add_session(
                db_session, stale_device, ws, started=3 * HOUR * 24, last=2 * HOUR * 24
            ),
        ],
        "paused": [
            await add_session(db_session, paused_device, ws, started=HOUR, last=MIN),
            await add_session(
                db_session,
                no_codex,
                ws,
                started=HOUR,
                last=MIN,
                harness="codex_desktop",
            ),
            await add_session(
                db_session,
                laptop,
                ws,
                started=HOUR,
                last=MIN,
                mapping_id=off_mapping.id,
            ),
            # Paused wins over a day of silence.
            await add_session(
                db_session, paused_device, ws, started=3 * HOUR * 24, last=2 * HOUR * 24
            ),
        ],
        "disconnected": [
            await add_session(db_session, stale_device, ws, started=HOUR, last=MIN),
            await add_session(
                db_session, revoked_device, ws, started=HOUR, last=20 * MIN
            ),
        ],
        "ended": [],
    }
    for device in (laptop, paused_device, stale_device):
        for gaps, state in ((0, "ended"), (2, "incomplete")):
            session = await add_session(
                db_session, device, ws, started=HOUR, last=30 * MIN, capture_gaps=gaps
            )
            session.ended_at = ended_at(session)
            session.status = "ended"
            expected[state].append(session)
    await db_session.flush()

    everything = await listed(client, "?limit=100")
    derived = {item["id"]: item["display_state"] for item in everything["items"]}
    for state, sessions in expected.items():
        want = {str(s.id) for s in sessions}
        assert {i for i, d in derived.items() if d == state} == want, state
        got = await listed(client, f"?state={state}&limit=100")
        assert {item["id"] for item in got["items"]} == want, state

    both = await listed(client, "?state=active&state=idle&limit=100")
    assert {item["display_state"] for item in both["items"]} == {"active", "idle"}
    assert len(both["items"]) == len(expected["active"]) + len(expected["idle"])
    assert (await client.get(SESSIONS + "?state=live")).status_code == 422


# --- sort --------------------------------------------------------------------


async def test_each_sort_walks_every_page_in_order_with_ties_by_id(
    client, db_session, laptop, test_workspace
):
    ws = test_workspace
    rows = [
        await add_session(
            db_session,
            laptop,
            ws,
            started=5 * HOUR,
            last=4 * HOUR,
            input_tokens=10,
            cost_usd=1.5,
        ),
        await add_session(
            db_session,
            laptop,
            ws,
            started=3 * HOUR,
            last=MIN,
            output_tokens=500,
            cost_usd=0.25,
        ),
        await add_session(
            db_session,
            laptop,
            ws,
            started=2 * HOUR,
            last=HOUR,
            cache_read_tokens=500,
            cost_usd=0.25,
        ),
        await add_session(db_session, laptop, ws, started=10 * HOUR, last=9 * HOUR),
        await add_session(
            db_session,
            laptop,
            ws,
            started=30 * MIN,
            last=10 * MIN,
            cache_creation_tokens=7,
            cost_usd=0.000001,
        ),
    ]

    def key_order(key, nulls_last=False):
        def sort_key(s):
            value = key(s)
            return (value is not None if nulls_last else True, value or 0, s.id)

        return [str(s.id) for s in sorted(rows, key=sort_key, reverse=True)]

    expectations = {
        "recent": key_order(lambda s: s.last_event_at),
        "started": key_order(lambda s: s.started_at),
        "duration": key_order(
            lambda s: round((s.last_event_at - s.started_at).total_seconds() * 1000)
        ),
        "tokens": key_order(
            lambda s: s.input_tokens
            + s.output_tokens
            + s.cache_read_tokens
            + s.cache_creation_tokens
        ),
        "cost": key_order(lambda s: s.cost_usd, nulls_last=True),
    }
    for sort, order in expectations.items():
        assert await all_pages(client, f"sort={sort}") == order, sort
        assert await all_pages(client, f"sort={sort}", limit=1) == order, sort
        whole = await listed(client, f"?sort={sort}&limit=100")
        assert [item["id"] for item in whole["items"]] == order, sort
    assert (await client.get(SESSIONS + "?sort=longest")).status_code == 422


async def test_a_cursor_only_continues_its_own_sort(
    client, db_session, laptop, test_workspace
):
    for hours in (1, 2, 3):
        await add_session(db_session, laptop, test_workspace, started=hours * HOUR)
    cursors = {
        sort: (await listed(client, f"?sort={sort}&limit=1"))["next_cursor"]
        for sort in ("recent", "started", "duration", "tokens", "cost")
    }
    for sort, cursor in cursors.items():
        for other in cursors:
            response = await client.get(
                f"{SESSIONS}?sort={other}&limit=1&cursor={cursor}"
            )
            if other == sort:
                assert response.status_code == 200, (sort, other)
            else:
                assert response.status_code == 422, (sort, other)
                assert response.json()["detail"] == "Invalid cursor"
    forged = base64.urlsafe_b64encode(
        json.dumps(["tokens", "not-a-number", str(uuid.uuid4())]).encode()
    ).decode()
    assert (
        await client.get(f"{SESSIONS}?sort=tokens&cursor={forged}")
    ).status_code == 422


async def test_recent_cursor_keeps_the_previous_release_format(
    client, db_session, laptop, test_workspace
):
    for hours in (1, 2, 3):
        await add_session(
            db_session, laptop, test_workspace, started=hours * HOUR, last=hours * MIN
        )
    cursor = (await listed(client, "?limit=1"))["next_cursor"]
    decoded = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    assert len(decoded) == 2


# --- linked work, since, children --------------------------------------------


async def test_linked_only_and_since_filter_before_paging(
    client,
    db_session,
    laptop,
    test_workspace,
    test_board,
    test_column,
    test_card,
    test_user,
):
    ws = test_workspace
    linked = []
    for minutes in range(1, 6):
        session = await add_session(
            db_session, laptop, ws, started=HOUR, last=minutes * MIN
        )
        if minutes % 2:
            await add_link(db_session, session, test_card)
            linked.append(str(session.id))
    gone = await card_on(
        db_session, test_board, test_column, test_user, "Deleted later"
    )
    dead_link = await add_session(db_session, laptop, ws, started=HOUR, last=7 * MIN)
    await add_link(db_session, dead_link, gone)
    await db_session.execute(delete(Card).where(Card.id == gone.id))
    old = await add_session(
        db_session, laptop, ws, started=10 * 24 * HOUR, last=9 * 24 * HOUR
    )
    await add_link(db_session, old, test_card)

    assert await all_pages(client, "linked_only=true", limit=1) == linked + [
        str(old.id)
    ]
    since = (datetime.now(timezone.utc) - 24 * HOUR).isoformat()
    assert (
        await all_pages(
            client, "linked_only=true&since=" + since.replace("+", "%2B"), limit=1
        )
        == linked
    )
    recent = await listed(client, "?limit=100&since=" + since.replace("+", "%2B"))
    assert str(old.id) not in {item["id"] for item in recent["items"]}


async def test_rows_carry_child_count_link_count_and_a_two_item_preview(
    client,
    db_session,
    laptop,
    test_workspace,
    test_board,
    test_column,
    test_user,
    test_note,
):
    ws = test_workspace
    parent = await add_session(db_session, laptop, ws, started=HOUR, native="parent")
    for name in ("child-a", "child-b"):
        await add_session(
            db_session,
            laptop,
            ws,
            started=30 * MIN,
            native=name,
            parent_session_id=parent.id,
            parent_native_session_id="parent",
        )
    consulted_recent = await card_on(
        db_session, test_board, test_column, test_user, "Read recently"
    )
    changed_old = await card_on(
        db_session, test_board, test_column, test_user, "Changed long ago"
    )
    changed_new = await card_on(
        db_session, test_board, test_column, test_user, "Changed lately"
    )
    both = await card_on(
        db_session, test_board, test_column, test_user, "Read then changed"
    )
    await add_link(
        db_session, parent, consulted_recent, relation="consulted", last_seen=MIN
    )
    await add_link(db_session, parent, changed_old, last_seen=50 * MIN, correlated=True)
    await add_link(db_session, parent, changed_new, last_seen=10 * MIN)
    await add_link(db_session, parent, both, relation="consulted", last_seen=2 * MIN)
    await add_link(db_session, parent, both, relation="changed", last_seen=40 * MIN)
    await add_link(
        db_session, parent, test_note, entity_type="note", relation="consulted"
    )

    row = next(
        item
        for item in (await listed(client, "?root_only=true"))["items"]
        if item["id"] == str(parent.id)
    )
    assert row["child_count"] == 2
    assert row["link_count"] == 5  # distinct cards and notes, not link rows
    assert row["link_preview"] == [
        {
            "entity_type": "card",
            "entity_id": str(changed_new.id),
            "board_id": str(test_board.id),
            "title": "Changed lately",
            "relation": "changed",
            "provenance": "exact",
        },
        {
            "entity_type": "card",
            "entity_id": str(both.id),
            "board_id": str(test_board.id),
            "title": "Read then changed",
            "relation": "changed",
            "provenance": "exact",
        },
    ]
    detail = (await client.get(f"{SESSIONS}/{parent.id}")).json()
    assert detail["child_count"] == 2 and detail["link_count"] == 5
    children = (await client.get(f"{SESSIONS}/{parent.id}/children")).json()["items"]
    assert [child["child_count"] for child in children] == [0, 0]
    assert [child["link_preview"] for child in children] == [[], []]


async def test_preview_hides_work_in_a_workspace_the_owner_left(
    client, db_session, laptop, test_workspace, test_card, test_user, second_user
):
    from app.models.workspace import Workspace

    other = Workspace(name="Other", slug="other", created_by=second_user.id)
    db_session.add(other)
    await db_session.flush()
    session = await add_session(db_session, laptop, test_workspace, started=HOUR)
    link = await add_link(db_session, session, test_card)
    link.workspace_id = other.id  # a link recorded in a workspace I am not in
    await db_session.flush()

    row = (await listed(client))["items"][0]
    assert row["link_count"] == 0 and row["link_preview"] == []
    assert (await listed(client, "?linked_only=true"))["items"] == []


async def test_other_members_sessions_never_match_any_filter(
    client, db_session, test_workspace, test_card, second_user
):
    db_session.add(
        WorkspaceMember(
            workspace_id=test_workspace.id,
            user_id=second_user.id,
            role=WorkspaceRole.member,
        )
    )
    their_device = await add_installation(db_session, second_user)
    theirs = await add_session(
        db_session,
        their_device,
        test_workspace,
        started=HOUR,
        title="secret plan",
        cost_usd=9,
    )
    await add_link(db_session, theirs, test_card)
    for query in ("?q=secret", "?linked_only=true", "?state=active", "?sort=cost"):
        assert (await listed(client, query))["items"] == [], query
    async with as_user(db_session, second_user) as other:
        assert [i["id"] for i in (await listed(other, "?q=secret"))["items"]] == [
            str(theirs.id)
        ]


async def test_agent_keys_cannot_search_sessions(agent_client, test_workspace):
    assert (await agent_client.get(SESSIONS + "?q=x&sort=cost")).status_code == 403


async def test_list_enrichment_is_a_fixed_number_of_statements(
    client,
    db_session,
    laptop,
    test_workspace,
    test_board,
    test_column,
    test_user,
    test_note,
):
    count = 0

    def _count(*_):
        nonlocal count
        count += 1

    async def statements(query):
        nonlocal count
        count = 0
        engine = db_session.get_bind()
        sa_event.listen(engine, "before_cursor_execute", _count)
        try:
            await listed(client, query)
        finally:
            sa_event.remove(engine, "before_cursor_execute", _count)
        return count

    async def sessions_with_links(n):
        for index in range(n):
            session = await add_session(
                db_session, laptop, test_workspace, started=HOUR
            )
            card = await card_on(
                db_session, test_board, test_column, test_user, f"Card {index}"
            )
            await add_link(db_session, session, card)
            await add_link(
                db_session, session, test_note, entity_type="note", relation="consulted"
            )
            await add_session(
                db_session,
                laptop,
                test_workspace,
                started=MIN,
                parent_session_id=session.id,
            )

    query = "?limit=100&state=active&q=&sort=cost&linked_only=true"
    await sessions_with_links(2)
    small = await statements(query)
    await sessions_with_links(25)
    assert await statements(query) == small
    assert small <= 12


# --- card and note lists -----------------------------------------------------


async def test_card_and_note_sessions_take_a_limit_with_the_rollup_over_all(
    client, db_session, laptop, test_workspace, test_board, test_card, test_note
):
    for minutes in (1, 2, 3):
        session = await add_session(
            db_session,
            laptop,
            test_workspace,
            started=HOUR,
            last=minutes * MIN,
            input_tokens=10,
        )
        await add_link(db_session, session, test_card)
        await add_link(db_session, session, test_note, entity_type="note")
    for path in (
        f"/api/workspaces/default/boards/{test_board.id}/cards/{test_card.id}/sessions",
        f"/api/workspaces/default/notes/{test_note.id}/sessions",
    ):
        page = (await client.get(path + "?limit=2")).json()
        assert len(page["items"]) == 2
        assert page["summary"]["session_count"] == 3
        assert page["summary"]["input_tokens"] == 30
        assert len((await client.get(path)).json()["items"]) == 3
        assert (await client.get(path + "?limit=0")).status_code == 422


# --- the started-sort index --------------------------------------------------


def test_started_sort_index_migration_is_additive_and_reverses(tmp_path):
    migration = _load(VERSIONS / "116_session_started_sort_index.py")
    assert (migration.revision, migration.down_revision) == ("116", "115")
    engine = create_engine("sqlite:///" + str(tmp_path / "started.db"))
    with engine.begin() as connection:
        _at_109(connection)
        migration.op = Operations(MigrationContext.configure(connection))
        for _ in range(2):  # up, down, and up again
            migration.upgrade()
            indexes = {
                index["name"]: index["column_names"]
                for index in inspect(connection).get_indexes("agent_sessions")
            }
            assert indexes["ix_agent_sessions_owner_started"] == [
                "owner_id",
                "workspace_id",
                "started_at",
                "id",
            ]
            migration.downgrade()
            assert "ix_agent_sessions_owner_started" not in {
                index["name"]
                for index in inspect(connection).get_indexes("agent_sessions")
            }
    engine.dispose()
