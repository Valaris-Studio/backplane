# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""B15 — CardRead.has_pending_approval derived from pending approval requests.

Kanban cards must surface an operator-facing flag when a blocked runner has
a pending approval referencing the card. The signal is derived, not stored:
- primary source: `approval_requests.action_payload.card_id` == card.id
- fallback: `agent_executions.cards_affected` includes card.id via
  `approval_requests.execution_id`
"""
import uuid
from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.approvals.approval import (
    ApprovalCategory,
    ApprovalRequest,
    ApprovalStatus,
)
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace


BASE = "/api/workspaces/default/boards"


def _url(board: Board, suffix: str = "") -> str:
    return f"{BASE}/{board.id}/cards{suffix}"


async def _make_agent(db_session: AsyncSession, user: User) -> Agent:
    agent = Agent(name="approval-agent", agent_type=AgentType.coding, created_by_id=user.id)
    db_session.add(agent)
    await db_session.flush()
    return agent


async def _make_approval(
    db_session: AsyncSession,
    *,
    workspace: Workspace,
    agent: Agent,
    action_payload: dict,
    status: ApprovalStatus = ApprovalStatus.pending,
    execution_id: uuid.UUID | None = None,
) -> ApprovalRequest:
    req = ApprovalRequest(
        agent_id=agent.id,
        workspace_id=workspace.id,
        category=ApprovalCategory.deletion,
        action_description="needs human decision",
        action_payload=action_payload,
        risk_score=60,
        status=status,
        execution_id=execution_id,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=24),
    )
    db_session.add(req)
    await db_session.flush()
    return req


async def test_card_read_has_pending_approval_false_by_default(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
):
    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["has_pending_approval"] is False
    assert data["pending_approval_id"] is None


async def test_card_read_has_pending_approval_true_when_pending_request_has_card_id_in_payload(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    agent = await _make_agent(db_session, test_user)
    approval = await _make_approval(
        db_session,
        workspace=test_workspace,
        agent=agent,
        action_payload={"card_id": str(test_card.id), "details": "delete thing"},
    )

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["has_pending_approval"] is True
    assert data["pending_approval_id"] == str(approval.id)


async def test_card_read_has_pending_approval_false_when_request_is_decided(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    agent = await _make_agent(db_session, test_user)
    for decided in (
        ApprovalStatus.approved,
        ApprovalStatus.rejected,
        ApprovalStatus.expired,
        ApprovalStatus.auto_approved,
    ):
        await _make_approval(
            db_session,
            workspace=test_workspace,
            agent=agent,
            action_payload={"card_id": str(test_card.id)},
            status=decided,
        )

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["has_pending_approval"] is False
    assert data["pending_approval_id"] is None


async def test_card_read_has_pending_approval_true_via_execution_cards_affected_fallback(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """When action_payload has no card_id, fall back to execution.cards_affected."""
    agent = await _make_agent(db_session, test_user)
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        cards_affected=[str(test_card.id)],
    )
    db_session.add(execution)
    await db_session.flush()

    approval = await _make_approval(
        db_session,
        workspace=test_workspace,
        agent=agent,
        action_payload={"details": "no card id here"},
        execution_id=execution.id,
    )

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["has_pending_approval"] is True
    assert data["pending_approval_id"] == str(approval.id)


async def test_board_detail_cards_enriched_with_pending_approval(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_card: Card,
    test_user: User,
):
    """Board-detail endpoint returns cards with has_pending_approval populated."""
    other_card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="Other",
        description="",
        position=2048.0,
        created_by=test_user.id,
    )
    db_session.add(other_card)
    await db_session.flush()

    agent = await _make_agent(db_session, test_user)
    approval = await _make_approval(
        db_session,
        workspace=test_workspace,
        agent=agent,
        action_payload={"card_id": str(test_card.id)},
    )

    response = await client.get(
        f"/api/workspaces/default/boards/{test_board.id}",
    )
    assert response.status_code == 200
    detail = response.json()
    all_cards = [c for col in detail["columns"] for c in col["cards"]]
    by_id = {c["id"]: c for c in all_cards}

    assert by_id[str(test_card.id)]["has_pending_approval"] is True
    assert by_id[str(test_card.id)]["pending_approval_id"] == str(approval.id)
    assert by_id[str(other_card.id)]["has_pending_approval"] is False
    assert by_id[str(other_card.id)]["pending_approval_id"] is None


async def test_board_detail_pending_approval_enrichment_is_single_query(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_column: Column,
    test_user: User,
):
    """Enriching N cards must NOT emit N approval queries — one batched SELECT."""
    agent = await _make_agent(db_session, test_user)

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
    for c in cards:
        await _make_approval(
            db_session,
            workspace=test_workspace,
            agent=agent,
            action_payload={"card_id": str(c.id)},
        )

    approval_query_count = 0
    # the session is bound to this test's private engine (see conftest.db_engine)
    sync_engine = db_session.get_bind()

    def _count(conn, cursor, statement, parameters, context, executemany):
        nonlocal approval_query_count
        if "approval_requests" in statement.lower():
            approval_query_count += 1

    event.listen(sync_engine, "before_cursor_execute", _count)
    try:
        response = await client.get(
            f"/api/workspaces/default/boards/{test_board.id}",
        )
    finally:
        event.remove(sync_engine, "before_cursor_execute", _count)

    assert response.status_code == 200
    assert approval_query_count <= 1, (
        f"expected 1 approval query, got {approval_query_count} (N+1)"
    )


async def test_card_read_has_pending_approval_false_when_approval_expired(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_card: Card,
    test_user: User,
):
    """An approval row whose expires_at has passed must not light up the flag.

    Card 50016881: monitoring broke 2026-04-20 because a runner crashed
    mid-cycle and the approval sweep job had not yet expired the row.
    """
    agent = await _make_agent(db_session, test_user)
    expired = ApprovalRequest(
        agent_id=agent.id,
        workspace_id=test_workspace.id,
        category=ApprovalCategory.deletion,
        action_description="stale",
        action_payload={"card_id": str(test_card.id)},
        risk_score=60,
        status=ApprovalStatus.pending,
        expires_at=datetime.now(timezone.utc) - timedelta(minutes=5),
    )
    db_session.add(expired)
    await db_session.flush()

    response = await client.get(_url(test_board, f"/{test_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["has_pending_approval"] is False
    assert data["pending_approval_id"] is None


async def test_card_read_has_pending_approval_false_in_done_column(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Cards that landed in a done-typed column must clear the flag.

    Card 50016881: a stuck pending row would otherwise keep the badge lit
    on a card that already shipped — confusing operators reviewing the
    board after the runner moved on.
    """
    from app.models.kanban.column import ColumnType as _CT

    done_col = Column(
        board_id=test_board.id,
        name="Done",
        position=4096.0,
        color="#22c55e",
        column_type=_CT.done,
    )
    db_session.add(done_col)
    await db_session.flush()

    done_card = Card(
        board_id=test_board.id,
        column_id=done_col.id,
        title="Shipped",
        description="",
        position=1024.0,
        created_by=test_user.id,
    )
    db_session.add(done_card)
    await db_session.flush()

    agent = await _make_agent(db_session, test_user)
    await _make_approval(
        db_session,
        workspace=test_workspace,
        agent=agent,
        action_payload={"card_id": str(done_card.id)},
    )

    response = await client.get(_url(test_board, f"/{done_card.id}"))
    assert response.status_code == 200
    data = response.json()
    assert data["has_pending_approval"] is False
    assert data["pending_approval_id"] is None
