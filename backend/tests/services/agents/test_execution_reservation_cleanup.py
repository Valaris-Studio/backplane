# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Reservation lifecycle mirrors execution lifecycle.

When an AgentExecution transitions to a terminal status (completed / failed),
the matching AgentReservation row for (agent_id, card_id, role) must be
deleted in the same transaction. This eliminates the dependency on the
post-stage `_reservation_still_eligible` check for the happy path: bugs in
that filter (e.g. heroed-card asymmetry) no longer cause cost-bleed re-claim
loops because the reservation is gone before the next /next-assignment poll.

Defense-in-depth: the TTL sweep and `_reservation_still_eligible` remain as
fallbacks; the explicit delete just becomes the primary path.
"""
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.reservation import AgentReservation
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.execution import ExecutionUpdate
from app.services.agents.execution import ExecutionService


async def _seed_execution_and_reservation(
    db_session: AsyncSession,
    *,
    agent: Agent,
    workspace: Workspace,
    role: str,
    card_id,
    board_id,
    status: ExecutionStatus = ExecutionStatus.started,
) -> AgentExecution:
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        action="implement",
        status=status,
        input_summary="seed",
        cards_affected=[str(card_id)],
        role=role,
    )
    db_session.add(execution)
    db_session.add(AgentReservation(
        agent_id=agent.id,
        card_id=card_id,
        workspace_id=workspace.id,
        board_id=board_id,
        role=role,
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()
    return execution


async def _count_reservations(db: AsyncSession, *, agent_id, card_id, role) -> int:
    result = await db.execute(
        select(AgentReservation).where(
            AgentReservation.agent_id == agent_id,
            AgentReservation.card_id == card_id,
            AgentReservation.role == role,
        )
    )
    return len(result.scalars().all())


async def test_execution_completed_deletes_matching_reservation(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_card,
):
    execution = await _seed_execution_and_reservation(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        role="implementer",
        card_id=test_card.id,
        board_id=test_card.board_id,
    )

    service = ExecutionService(db_session)
    result = await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(status=ExecutionStatus.completed, output_summary="done"),
    )

    assert result.status == ExecutionStatus.completed
    remaining = await _count_reservations(
        db_session, agent_id=test_agent.id, card_id=test_card.id, role="implementer"
    )
    assert remaining == 0, "completed execution must clear matching reservation"


async def test_execution_failed_deletes_matching_reservation(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_card,
):
    execution = await _seed_execution_and_reservation(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        role="implementer",
        card_id=test_card.id,
        board_id=test_card.board_id,
    )

    service = ExecutionService(db_session)
    await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(status=ExecutionStatus.failed, error_message="boom"),
    )

    remaining = await _count_reservations(
        db_session, agent_id=test_agent.id, card_id=test_card.id, role="implementer"
    )
    assert remaining == 0, "failed execution must clear matching reservation"


async def test_execution_running_does_not_delete_reservation(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_card,
):
    execution = await _seed_execution_and_reservation(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        role="implementer",
        card_id=test_card.id,
        board_id=test_card.board_id,
    )

    service = ExecutionService(db_session)
    await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(status=ExecutionStatus.running, output_summary="still working"),
    )

    remaining = await _count_reservations(
        db_session, agent_id=test_agent.id, card_id=test_card.id, role="implementer"
    )
    assert remaining == 1, "non-terminal status must leave reservation intact"


async def test_execution_completed_no_reservation_is_idempotent_noop(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_card,
):
    # Seed only the execution; no reservation row. Completing the execution
    # must not raise — idempotent cleanup is required for LLM retry resilience.
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement",
        status=ExecutionStatus.started,
        input_summary="orphan",
        cards_affected=[str(test_card.id)],
        role="implementer",
    )
    db_session.add(execution)
    await db_session.flush()

    service = ExecutionService(db_session)
    result = await service.update_execution(
        test_agent.id,
        execution.id,
        ExecutionUpdate(status=ExecutionStatus.completed),
    )
    assert result.status == ExecutionStatus.completed


async def test_execution_completed_only_deletes_matching_role(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
    test_board,
    test_column,
):
    # The unique constraint on agent_reservations is on card_id alone, so
    # two reservations for the same card cannot coexist. Use two distinct
    # cards (one per role) to verify role-scoped deletion: completing the
    # implementer execution must NOT touch the reviewer reservation on a
    # different card.
    from app.models.kanban.card import Card

    impl_card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="impl-card",
        position=2048.0,
        created_by=test_user.id,
    )
    review_card = Card(
        board_id=test_board.id,
        column_id=test_column.id,
        title="review-card",
        position=3072.0,
        created_by=test_user.id,
    )
    db_session.add_all([impl_card, review_card])
    await db_session.flush()

    impl_execution = await _seed_execution_and_reservation(
        db_session,
        agent=test_agent,
        workspace=test_workspace,
        role="implementer",
        card_id=impl_card.id,
        board_id=test_board.id,
    )
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=review_card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="reviewer",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    ))
    await db_session.flush()

    service = ExecutionService(db_session)
    await service.update_execution(
        test_agent.id,
        impl_execution.id,
        ExecutionUpdate(status=ExecutionStatus.completed),
    )

    impl_remaining = await _count_reservations(
        db_session, agent_id=test_agent.id, card_id=impl_card.id, role="implementer"
    )
    reviewer_remaining = await _count_reservations(
        db_session, agent_id=test_agent.id, card_id=review_card.id, role="reviewer"
    )
    assert impl_remaining == 0, "implementer reservation should be cleared"
    assert reviewer_remaining == 1, "reviewer reservation on a different card must survive"
