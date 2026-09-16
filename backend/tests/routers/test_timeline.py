# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Phase-1 Board Timeline endpoint.

GET /api/workspaces/{slug}/boards/{board_id}/timeline

Frozen contract (frontend/docs/timeline-simulator-contract.md):
- Returns the full board activity log ASCending by created_at (oldest -> newest).
- Each event extends ActivityRead with nullable before_state / after_state.
- Envelope: { board_id, generated_at, truncated, events: [...] }.
- Bound at a high limit (default 5000); over-limit returns the OLDEST N with
  truncated: true.
- Same workspace-membership auth as the history endpoint (403 non-member,
  404 foreign board).

TDD RED: the endpoint does not exist yet (404 routing) and the snapshot columns
are absent, so these fail today — NOT on import.
"""

import uuid
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


async def test_get_board_timeline_empty(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["board_id"] == str(test_board.id)
    assert body["truncated"] is False
    assert body["events"] == []
    assert "generated_at" in body and body["generated_at"]


async def test_get_board_timeline_ascending(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    now = datetime.now(timezone.utc)
    for i in range(3):
        db_session.add(
            Activity(
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.card,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary=f"Event {i}",
                created_at=now + timedelta(seconds=i),
            )
        )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    events = response.json()["events"]
    assert len(events) == 3
    # ASC: oldest first (opposite of /history which is DESC).
    assert events[0]["summary"] == "Event 0"
    assert events[-1]["summary"] == "Event 2"


async def test_get_board_timeline_same_second_burst_is_insertion_ordered(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Events sharing one created_at tick fold in INSERTION order, deterministically.

    A single API request / runner tick can record several activities in the same
    1-second tick. The frontend folds them forward to reconstruct board state, so
    the order MUST be the order they happened. Ordering by (created_at, random
    uuid4 id) returns a RANDOM order for a same-tick burst — this test pins the
    monotonic `seq` contract and fails against that old ordering.
    """
    pinned = datetime(2026, 6, 8, 12, 0, 0, tzinfo=timezone.utc)
    n = 12
    created = []
    for i in range(n):
        act = Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary=f"Burst {i:02d}",
            created_at=pinned,  # identical tick for every row
        )
        db_session.add(act)
        await db_session.flush()  # per-row flush -> strictly increasing seq
        created.append(act)

    # seq is DB-assigned (Identity on Postgres) / counter-assigned (sqlite tests)
    # and must be strictly increasing in insertion order.
    seqs = [a.seq for a in created]
    assert all(seqs[i] < seqs[i + 1] for i in range(len(seqs) - 1)), seqs

    # The timeline must return the same-tick burst in exact insertion order,
    # and do so repeatably across calls (no random reshuffle).
    expected = [f"Burst {i:02d}" for i in range(n)]
    for _ in range(3):
        response = await client.get(
            f"/api/workspaces/default/boards/{test_board.id}/timeline"
        )
        assert response.status_code == 200
        summaries = [e["summary"] for e in response.json()["events"]]
        assert summaries == expected


async def test_get_board_timeline_includes_snapshot_fields(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="Card created",
            before_state=None,
            after_state={"id": str(uuid.uuid4()), "title": "Hello"},
        )
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    event = response.json()["events"][0]
    assert "before_state" in event
    assert "after_state" in event
    assert event["before_state"] is None
    assert event["after_state"]["title"] == "Hello"


async def test_get_board_timeline_reflects_real_card_creation(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """End-to-end: creating a card via the API lands a real after_state snapshot."""
    # Discover a column on the default-seeded board.
    board_resp = await client.get(f"/api/workspaces/default/boards/{test_board.id}")
    assert board_resp.status_code == 200
    columns = board_resp.json()["columns"]
    # test_board fixture has no default columns; create one.
    if not columns:
        col_resp = await client.post(
            f"/api/workspaces/default/boards/{test_board.id}/columns",
            json={"name": "To Do"},
        )
        assert col_resp.status_code == 201
        column_id = col_resp.json()["id"]
    else:
        column_id = columns[0]["id"]

    card_resp = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/cards",
        json={"title": "Timeline E2E card", "column_id": column_id},
    )
    assert card_resp.status_code in (200, 201)

    timeline = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert timeline.status_code == 200
    events = timeline.json()["events"]
    card_events = [
        e
        for e in events
        if e["entity_type"] == "card" and e["action"] == "created"
    ]
    assert card_events, "expected a card 'created' timeline event"
    assert card_events[-1]["after_state"] is not None
    assert card_events[-1]["after_state"]["title"] == "Timeline E2E card"
    assert card_events[-1]["before_state"] is None


async def test_get_board_timeline_truncated_flag(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    now = datetime.now(timezone.utc)
    for i in range(3):
        db_session.add(
            Activity(
                workspace_id=test_workspace.id,
                board_id=test_board.id,
                actor_id=test_user.id,
                entity_type=ActivityEntityType.card,
                entity_id=uuid.uuid4(),
                action=ActivityAction.created,
                summary=f"E{i}",
                created_at=now + timedelta(seconds=i),
            )
        )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline?limit=2"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is True
    assert len(body["events"]) == 2
    # Truncation keeps the OLDEST events.
    assert body["events"][0]["summary"] == "E0"
    assert body["events"][1]["summary"] == "E1"


async def test_get_board_timeline_not_truncated_under_limit(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="Only one",
        )
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline?limit=2"
    )
    assert response.status_code == 200
    body = response.json()
    assert body["truncated"] is False
    assert len(body["events"]) == 1


async def test_get_board_timeline_only_this_board(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    # Event on this board.
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="Mine",
        )
    )
    # Another board in the same workspace — must NOT appear.
    other_board = Board(
        workspace_id=test_workspace.id, name="Other", created_by=test_user.id
    )
    db_session.add(other_board)
    await db_session.flush()
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            board_id=other_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="Not mine",
        )
    )
    # Workspace-level event (no board) — must NOT appear.
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.board,
            entity_id=uuid.uuid4(),
            action=ActivityAction.created,
            summary="WS level",
        )
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    summaries = [e["summary"] for e in response.json()["events"]]
    assert summaries == ["Mine"]


async def test_get_board_timeline_legacy_null_snapshots(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Pre-migration rows (no snapshots) serialize before/after as null."""
    db_session.add(
        Activity(
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            actor_id=test_user.id,
            entity_type=ActivityEntityType.card,
            entity_id=uuid.uuid4(),
            action=ActivityAction.moved,
            summary="Legacy move",
            changes={"column_id": {"old": "x", "new": "y"}},
        )
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    event = response.json()["events"][0]
    assert event["before_state"] is None
    assert event["after_state"] is None
    # legacy changes still flow through
    assert event["changes"]["column_id"]["new"] == "y"


# --------------------------------------------------------------------------- #
# v1.1 — current-state baseline (makes legacy boards useful)                   #
# --------------------------------------------------------------------------- #


async def test_get_board_timeline_baseline_present_and_empty_board(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """An empty board still returns a baseline object with empty columns/cards
    (never null for a real board)."""
    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    body = response.json()
    assert "baseline" in body
    assert body["baseline"] is not None
    assert body["baseline"]["columns"] == []
    assert body["baseline"]["cards"] == []


async def test_get_board_timeline_baseline_reflects_current_columns_ordered(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """baseline.columns are the board's live columns with REAL names, ordered by
    position (not the random/null snapshots a legacy fold would produce)."""
    # Create two columns; the second gets a higher position than the first.
    first = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/columns",
        json={"name": "To Do"},
    )
    second = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/columns",
        json={"name": "Done"},
    )
    assert first.status_code == 201 and second.status_code == 201

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    baseline = response.json()["baseline"]
    cols = baseline["columns"]
    assert len(cols) == 2
    # Real names, ordered by position ascending.
    assert [c["name"] for c in cols] == ["To Do", "Done"]
    assert cols[0]["position"] < cols[1]["position"]
    # ColumnSnapshot shape
    for c in cols:
        assert "id" in c
        assert "column_type" in c
        assert "position" in c


async def test_get_board_timeline_baseline_reflects_current_cards_with_participants(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    second_user: User,
):
    """baseline.cards carry real titles + column_id + role-agnostic participants
    (the snapshot_card shape), built from the eager-loaded board detail."""
    col = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/columns",
        json={"name": "Backlog"},
    )
    assert col.status_code == 201
    column_id = col.json()["id"]

    card = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/cards",
        json={"title": "Baseline card", "column_id": column_id},
    )
    assert card.status_code in (200, 201)
    card_id = card.json()["id"]

    # Attach a participant with an opaque pipeline-role so we can assert it flows.
    part = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/cards/{card_id}/participants",
        json={
            "user_id": str(second_user.id),
            "role": "helper",
            "pipeline_role": "ui_validator",
        },
    )
    assert part.status_code == 201

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    baseline = response.json()["baseline"]
    cards = baseline["cards"]
    assert len(cards) == 1
    snap = cards[0]
    assert snap["id"] == card_id
    assert snap["title"] == "Baseline card"
    assert snap["column_id"] == column_id
    # CardSnapshot shape (minimal field set the FE folds forward).
    for key in ("card_type", "priority", "position", "status", "labels", "participants"):
        assert key in snap
    # Role-agnostic participant carried through verbatim.
    roles = {p["role"] for p in snap["participants"]}
    assert "ui_validator" in roles
    p = snap["participants"][0]
    assert p["user_id"] == str(second_user.id)
    assert "name" in p
    assert "avatar_url" in p
    assert "agent_id" in p


async def test_get_board_timeline_baseline_cards_span_all_columns(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """baseline.cards is the flat list of every card across all board columns."""
    cols = []
    for name in ("A", "B"):
        r = await client.post(
            f"/api/workspaces/default/boards/{test_board.id}/columns",
            json={"name": name},
        )
        assert r.status_code == 201
        cols.append(r.json()["id"])

    titles = {"A": "card-in-a", "B": "card-in-b"}
    for name, column_id in zip(("A", "B"), cols):
        r = await client.post(
            f"/api/workspaces/default/boards/{test_board.id}/cards",
            json={"title": titles[name], "column_id": column_id},
        )
        assert r.status_code in (200, 201)

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    cards = response.json()["baseline"]["cards"]
    assert {c["title"] for c in cards} == {"card-in-a", "card-in-b"}
    # Each card's column_id points at one of the two created columns.
    assert {c["column_id"] for c in cards} == set(cols)


async def test_get_board_timeline_foreign_board_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """A board UUID that exists but in another workspace -> 404 via resolve_board_id."""
    other_ws = Workspace(name="Other WS", slug="other-ws", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    foreign_board = Board(
        workspace_id=other_ws.id, name="Foreign", created_by=test_user.id
    )
    db_session.add(foreign_board)
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/default/boards/{foreign_board.id}/timeline"
    )
    assert response.status_code == 404


async def test_get_board_timeline_nonmember_forbidden(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
):
    """A workspace the requesting user is NOT a member of -> 403.

    The `client` fixture authenticates as test_user, who is owner of `default`
    but has no membership in this second workspace.
    """
    other_ws = Workspace(name="Locked", slug="locked", created_by=second_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    other_board = Board(
        workspace_id=other_ws.id, name="Locked Board", created_by=test_user.id
    )
    db_session.add(other_board)
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/locked/boards/{other_board.id}/timeline"
    )
    assert response.status_code == 403


async def test_get_board_timeline_default_limit_is_500():
    """The endpoint default is bounded at 500 (not its own 5000 maximum) so a
    plain call can't accidentally pull 5000 rows with JSONB snapshots plus a
    full-board baseline. The replay caller that needs the whole log passes an
    explicit limit=5000. le stays 5000."""
    import inspect

    from app.routers.activity import get_board_timeline

    limit_param = inspect.signature(get_board_timeline).parameters["limit"]
    query = limit_param.default
    assert query.default == 500, "timeline default limit must be lowered to 500"
    # `le` rides in annotated-constraint metadata (Le(le=5000)) in this FastAPI.
    le_values = [getattr(m, "le", None) for m in query.metadata]
    assert 5000 in le_values, "the 5000 ceiling must be preserved"


async def test_baseline_cards_carry_created_at_for_no_time_travel(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """baseline.cards include the card's created_at so the timeline engine can
    withhold cards born INSIDE the logged window even when no per-card create
    event exists (bulk_create_cards records ONE activity for N cards)."""
    col = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/columns",
        json={"name": "Backlog"},
    )
    assert col.status_code == 201

    bulk = await client.post(
        f"/api/workspaces/default/boards/{test_board.id}/cards/bulk",
        json={
            "cards": [
                {"title": "Bulk one", "column_id": col.json()["id"]},
                {"title": "Bulk two", "column_id": col.json()["id"]},
            ]
        },
    )
    assert bulk.status_code in (200, 201)

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}/timeline"
    )
    assert response.status_code == 200
    cards = response.json()["baseline"]["cards"]
    assert len(cards) == 2
    for snap in cards:
        assert snap.get("created_at"), "baseline card must carry created_at"
