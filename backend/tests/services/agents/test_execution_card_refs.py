# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""ExecutionService enriches cards_affected into cards_affected_detail.

Each in-flight/completed execution's affected card ids resolve to
{id, title, board_id} — computed in the service, read off the ORM instance by
ExecutionRead.from_attributes. The union of card ids across the whole batch is
resolved in ONE query (no N+1). Deleted cards drop from the detail list but stay
in the raw cards_affected for a truncated-id fallback.
"""
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.execution import ExecutionCreate, ExecutionUpdate
from app.services.agents.execution import ExecutionService


def _new_card(db, *, board, column, user, title) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    return card


def _detail_by_id(execution) -> dict:
    return {ref.id: ref for ref in execution.cards_affected_detail}


async def test_list_workspace_executions_populates_cards_affected_detail(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_card: Card,
):
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        input_summary="seed",
        cards_affected=[str(test_card.id)],
        role="implementer",
    )
    db_session.add(execution)
    await db_session.flush()

    service = ExecutionService(db_session)
    rows = await service.list_workspace_executions(test_workspace.id)

    assert len(rows) == 1
    detail = rows[0].cards_affected_detail
    assert len(detail) == 1
    assert detail[0].id == str(test_card.id)
    assert detail[0].title == test_card.title
    assert detail[0].board_id == str(test_board.id)


async def test_list_executions_populates_cards_affected_detail(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_card: Card,
):
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="seed",
        cards_affected=[str(test_card.id)],
        role="implementer",
    )
    db_session.add(execution)
    await db_session.flush()

    service = ExecutionService(db_session)
    rows = await service.list_executions(test_agent.id)

    assert len(rows) == 1
    detail = _detail_by_id(rows[0])
    assert str(test_card.id) in detail
    assert detail[str(test_card.id)].title == test_card.title


async def test_start_execution_returns_cards_affected_detail(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_card: Card,
):
    service = ExecutionService(db_session)
    execution = await service.start_execution(
        test_agent.id,
        ExecutionCreate(
            workspace_slug=test_workspace.slug,
            board_id=test_board.id,
            card_id=test_card.id,
            action="implement",
            input_summary="start",
            role="implementer",
        ),
    )

    detail = execution.cards_affected_detail
    assert len(detail) == 1
    assert detail[0].id == str(test_card.id)
    assert detail[0].title == test_card.title
    assert detail[0].board_id == str(test_board.id)


async def test_update_execution_returns_cards_affected_detail(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_card: Card,
):
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.started,
        input_summary="seed",
        cards_affected=[str(test_card.id)],
        role="implementer",
    )
    db_session.add(execution)
    await db_session.flush()

    service = ExecutionService(db_session)
    result = await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(status=ExecutionStatus.running, output_summary="working"),
    )

    detail = result.cards_affected_detail
    assert len(detail) == 1
    assert detail[0].title == test_card.title
    assert detail[0].board_id == str(test_board.id)


async def test_deleted_card_omitted_from_detail_but_kept_in_raw(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_card: Card,
):
    ghost_id = str(uuid.uuid4())
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.running,
        input_summary="seed",
        cards_affected=[str(test_card.id), ghost_id],
        role="implementer",
    )
    db_session.add(execution)
    await db_session.flush()

    service = ExecutionService(db_session)
    rows = await service.list_workspace_executions(test_workspace.id)

    row = rows[0]
    detail_ids = {ref.id for ref in row.cards_affected_detail}
    assert detail_ids == {str(test_card.id)}, "deleted card omitted from detail"
    assert ghost_id in row.cards_affected, "deleted card id kept in raw list"


async def test_multi_execution_batch_resolves_cards_in_single_query(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board: Board,
    test_column: Column,
):
    # 5 executions, each touching a distinct card. Enrichment MUST resolve the
    # union of card ids in ONE query — a per-execution resolve is N+1.
    cards = [
        _new_card(db_session, board=test_board, column=test_column, user=test_user, title=f"C{i}")
        for i in range(5)
    ]
    await db_session.flush()

    for card in cards:
        db_session.add(AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            action="implement",
            status=ExecutionStatus.running,
            input_summary="seed",
            cards_affected=[str(card.id)],
            role="implementer",
        ))
    await db_session.flush()

    service = ExecutionService(db_session)

    query_count = 0
    original_get_refs = service.card_repo.get_refs_by_ids

    async def counting_get_refs(ids):
        nonlocal query_count
        query_count += 1
        return await original_get_refs(ids)

    service.card_repo.get_refs_by_ids = counting_get_refs

    rows = await service.list_workspace_executions(test_workspace.id)

    assert len(rows) == 5
    assert query_count == 1, "cards must be resolved in a single batch query"
    for row in rows:
        assert len(row.cards_affected_detail) == 1
