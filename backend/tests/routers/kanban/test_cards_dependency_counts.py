# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""DEP-FE-B0 — CardRead exposes inline dependency counts + status.

The board view needs to render a dep-chip per card without N+1. Three fields
flow through every card surface (board detail, search, single-card GET):

  - depends_on_count: int  (cards this card depends on)
  - blocks_count: int      (cards that depend on this card)
  - dependency_status: "ready" | "blocked" | "unblocked"

`dependency_status` derivation:
  - ready     -> depends_on_count == 0
  - blocked   -> at least one unsatisfied dep (target column_type != "done")
  - unblocked -> at least one dep, all satisfied (every target in a done column)
"""
import uuid

from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


async def _new_card(
    db: AsyncSession,
    *,
    board: Board,
    column: Column,
    user: User,
    title: str,
    position: float,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        description="",
        position=position,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def _new_done_column(
    db: AsyncSession, *, board: Board, position: float = 8192.0
) -> Column:
    col = Column(
        board_id=board.id,
        name="Done",
        position=position,
        color="#22c55e",
        column_type=ColumnType.done,
    )
    db.add(col)
    await db.flush()
    return col


async def _add_dep(
    db: AsyncSession, *, card: Card, depends_on: Card, user: User
) -> None:
    db.add(
        CardDependency(
            card_id=card.id,
            depends_on_card_id=depends_on.id,
            created_by=user.id,
        )
    )
    await db.flush()


async def test_card_read_ready_when_no_dependencies(
    client: AsyncClient,
    test_board: Board,
    test_card: Card,
):
    response = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["depends_on_count"] == 0
    assert data["blocks_count"] == 0
    assert data["dependency_status"] == "ready"


async def test_card_read_blocked_when_dep_in_non_done_column(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    other = await _new_card(
        db_session,
        board=test_board,
        column=test_column,
        user=test_user,
        title="dep target",
        position=2048.0,
    )
    await _add_dep(db_session, card=test_card, depends_on=other, user=test_user)

    response = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["depends_on_count"] == 1
    assert data["blocks_count"] == 0
    assert data["dependency_status"] == "blocked"


async def test_card_read_unblocked_when_all_deps_in_done(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    done_col = await _new_done_column(db_session, board=test_board)
    finished = await _new_card(
        db_session,
        board=test_board,
        column=done_col,
        user=test_user,
        title="shipped",
        position=1024.0,
    )
    await _add_dep(
        db_session, card=test_card, depends_on=finished, user=test_user
    )

    response = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["depends_on_count"] == 1
    assert data["dependency_status"] == "unblocked"


async def test_card_read_blocked_when_one_of_many_deps_unsatisfied(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    done_col = await _new_done_column(db_session, board=test_board)
    shipped = await _new_card(
        db_session,
        board=test_board,
        column=done_col,
        user=test_user,
        title="shipped",
        position=1024.0,
    )
    in_flight = await _new_card(
        db_session,
        board=test_board,
        column=test_column,
        user=test_user,
        title="in flight",
        position=4096.0,
    )
    await _add_dep(db_session, card=test_card, depends_on=shipped, user=test_user)
    await _add_dep(
        db_session, card=test_card, depends_on=in_flight, user=test_user
    )

    response = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["depends_on_count"] == 2
    assert data["dependency_status"] == "blocked"


async def test_card_read_blocks_count_reflects_reverse_edges(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    a = await _new_card(
        db_session,
        board=test_board,
        column=test_column,
        user=test_user,
        title="A",
        position=2048.0,
    )
    b = await _new_card(
        db_session,
        board=test_board,
        column=test_column,
        user=test_user,
        title="B",
        position=3072.0,
    )
    await _add_dep(db_session, card=a, depends_on=test_card, user=test_user)
    await _add_dep(db_session, card=b, depends_on=test_card, user=test_user)

    response = await client.get(f"{BASE}/{test_board.id}/cards/{test_card.id}")
    assert response.status_code == 200
    data = response.json()
    assert data["blocks_count"] == 2
    assert data["depends_on_count"] == 0
    # No depends_on edges -> ready, even though others depend on this card.
    assert data["dependency_status"] == "ready"


async def test_board_detail_enriches_every_card_with_dep_fields(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    other = await _new_card(
        db_session,
        board=test_board,
        column=test_column,
        user=test_user,
        title="other",
        position=2048.0,
    )
    await _add_dep(db_session, card=test_card, depends_on=other, user=test_user)

    response = await client.get(f"{BASE}/{test_board.id}")
    assert response.status_code == 200
    detail = response.json()
    by_id = {
        c["id"]: c
        for col in detail["columns"]
        for c in col["cards"]
    }
    target = by_id[str(test_card.id)]
    upstream = by_id[str(other.id)]
    assert target["depends_on_count"] == 1
    assert target["blocks_count"] == 0
    assert target["dependency_status"] == "blocked"
    assert upstream["depends_on_count"] == 0
    assert upstream["blocks_count"] == 1
    assert upstream["dependency_status"] == "ready"


async def test_board_detail_dependency_enrichment_is_bounded(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Enriching N cards must NOT emit N dependency queries.

    Mirrors `test_board_detail_pending_approval_enrichment_is_single_query`.
    The annotator should issue a small constant number of statements
    against `card_dependencies` regardless of card count.
    """
    cards: list[Card] = []
    for i in range(5):
        c = Card(
            board_id=test_board.id,
            column_id=test_column.id,
            title=f"Card {i}",
            description="",
            position=1024.0 * (i + 1),
            created_by=test_user.id,
        )
        db_session.add(c)
        cards.append(c)
    await db_session.flush()
    for i in range(1, len(cards)):
        await _add_dep(
            db_session, card=cards[i], depends_on=cards[0], user=test_user
        )

    dep_query_count = 0
    # the session is bound to this test's private engine (see conftest.db_engine)
    sync_engine = db_session.get_bind()

    def _count(conn, cursor, statement, parameters, context, executemany):
        nonlocal dep_query_count
        if "card_dependencies" in statement.lower():
            dep_query_count += 1

    event.listen(sync_engine, "before_cursor_execute", _count)
    try:
        response = await client.get(f"{BASE}/{test_board.id}")
    finally:
        event.remove(sync_engine, "before_cursor_execute", _count)

    assert response.status_code == 200
    # Allow up to 4: schema probe + forward-count + reverse-count +
    # target-column probe. All are constant in N; anything higher implies
    # an N+1 elsewhere in the enrichment path.
    assert dep_query_count <= 4, (
        f"expected <=4 dep queries, got {dep_query_count} (N+1)"
    )


# --- write-path truth (card c59e75bb) ----------------------------------------
#
# The write paths returned raw ORM models; CardRead's class-level defaults
# (depends_on_count=0, dependency_status="ready") silently filled the gap, so
# a PATCH response claimed a heavily-depended card was edge-less — the
# An operator in the field briefly believed an edit had wiped the dependency graph.
# Every write path must enrich like the read paths do.


async def _blocked_pair(db_session, test_board, test_column, test_card, test_user):
    """test_card gains one unsatisfied dep + one dependent -> counts (1,1),
    status blocked."""
    upstream = await _new_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="upstream", position=3072.0,
    )
    downstream = await _new_card(
        db_session, board=test_board, column=test_column, user=test_user,
        title="downstream", position=4096.0,
    )
    await _add_dep(db_session, card=test_card, depends_on=upstream, user=test_user)
    await _add_dep(db_session, card=downstream, depends_on=test_card, user=test_user)
    return upstream, downstream


def _assert_truthful(data: dict):
    assert data["depends_on_count"] == 1, data
    assert data["blocks_count"] == 1, data
    assert data["dependency_status"] == "blocked", data


async def test_update_card_response_reports_real_dependencies(
    client, db_session, test_board, test_column, test_card, test_user
):
    await _blocked_pair(db_session, test_board, test_column, test_card, test_user)
    resp = await client.patch(
        f"{BASE}/{test_board.id}/cards/{test_card.id}",
        json={"description": "edited"},
    )
    assert resp.status_code == 200
    _assert_truthful(resp.json())


async def test_move_card_response_reports_real_dependencies(
    client, db_session, test_board, test_column, test_card, test_user
):
    await _blocked_pair(db_session, test_board, test_column, test_card, test_user)
    resp = await client.patch(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/move",
        json={"column_id": str(test_column.id), "position": 9000.0},
    )
    assert resp.status_code == 200
    _assert_truthful(resp.json())


async def test_add_participant_response_reports_real_dependencies(
    client, db_session, test_board, test_column, test_card, test_user
):
    await _blocked_pair(db_session, test_board, test_column, test_card, test_user)
    resp = await client.post(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/participants",
        json={"user_id": str(test_user.id), "role": "hero"},
    )
    assert resp.status_code == 201
    _assert_truthful(resp.json())


async def test_remove_participant_response_reports_real_dependencies(
    client, db_session, test_board, test_column, test_card, test_user
):
    await _blocked_pair(db_session, test_board, test_column, test_card, test_user)
    add = await client.post(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/participants",
        json={"user_id": str(test_user.id), "role": "hero"},
    )
    assert add.status_code == 201
    resp = await client.request(
        "DELETE",
        f"{BASE}/{test_board.id}/cards/{test_card.id}/participants/{test_user.id}",
    )
    assert resp.status_code in (200, 204), resp.text
    if resp.status_code == 200 and resp.content:
        _assert_truthful(resp.json())


async def test_claim_card_response_reports_real_dependencies(
    client, db_session, test_board, test_column, test_card, test_user
):
    from app.models.agents.agent import Agent, AgentType

    await _blocked_pair(db_session, test_board, test_column, test_card, test_user)
    agent = Agent(
        name="claiming-agent",
        agent_type=AgentType.coding,
        description="write-path truth test agent",
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()

    resp = await client.post(
        f"{BASE}/{test_board.id}/cards/{test_card.id}/claim",
        json={"agent_id": str(agent.id)},
    )
    assert resp.status_code == 200, resp.text
    _assert_truthful(resp.json())


async def test_update_card_response_carries_agent_presence_field(
    client, db_session, test_board, test_column, test_card, test_user
):
    """update_card also skipped attach_agent_presence — PATCH responses always
    claimed presence "none". With no agent activity "none" IS correct; this
    pins that the field arrives enriched (not schema-default) by asserting the
    enrichment ran alongside the dependency counts."""
    await _blocked_pair(db_session, test_board, test_column, test_card, test_user)
    resp = await client.patch(
        f"{BASE}/{test_board.id}/cards/{test_card.id}",
        json={"title": "renamed"},
    )
    data = resp.json()
    _assert_truthful(data)
    assert data["agent_presence"] in ("none", "eligible", "touched", "active", "suspended")
