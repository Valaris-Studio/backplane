# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for extended board health metrics: Agent Efficiency, Handoff Friction, Reversion Rate."""
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.board import Board
from app.models.kanban.card import Card, Priority
from app.models.kanban.column import Column
from app.models.user import User
from app.models.workspace import Workspace
from app.services.kanban.board_health import BoardHealthService


async def _setup_board_with_columns(
    db: AsyncSession, workspace: Workspace, user: User
) -> tuple[Board, Column, Column, Column]:
    board = Board(workspace_id=workspace.id, name="Health Board", created_by=user.id)
    db.add(board)
    await db.flush()

    todo = Column(board_id=board.id, name="To Do", position=1024.0, color="#6b7280")
    wip = Column(board_id=board.id, name="In Progress", position=2048.0, color="#3b82f6")
    done = Column(board_id=board.id, name="Done", position=3072.0, color="#22c55e")
    db.add_all([todo, wip, done])
    await db.flush()
    return board, todo, wip, done


async def test_health_includes_agent_efficiency_score(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Agent Efficiency Score = completed_executions / total_executions for the board."""
    board, todo, wip, done = await _setup_board_with_columns(db_session, test_workspace, test_user)

    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    # 3 executions: 2 completed, 1 failed
    for status in [ExecutionStatus.completed, ExecutionStatus.completed, ExecutionStatus.failed]:
        db_session.add(AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            board_id=board.id,
            action="implement",
            status=status,
        ))
    await db_session.flush()

    # Need at least one card for health to compute
    db_session.add(Card(
        board_id=board.id, column_id=todo.id, title="T1",
        position=1024.0, created_by=test_user.id, priority=Priority.medium,
        description="desc",
    ))
    await db_session.flush()

    service = BoardHealthService(db_session)
    health = await service.get_health(board.id, test_workspace.id)

    assert health.agent_efficiency_score is not None
    # 2 completed / 3 total = 0.667
    assert abs(health.agent_efficiency_score - 0.667) < 0.01


async def test_health_agent_efficiency_no_executions(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Agent Efficiency Score is None when there are no executions."""
    board, todo, wip, done = await _setup_board_with_columns(db_session, test_workspace, test_user)

    db_session.add(Card(
        board_id=board.id, column_id=todo.id, title="T1",
        position=1024.0, created_by=test_user.id, priority=Priority.medium,
        description="desc",
    ))
    await db_session.flush()

    service = BoardHealthService(db_session)
    health = await service.get_health(board.id, test_workspace.id)
    assert health.agent_efficiency_score is None


async def test_health_includes_handoff_friction(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Handoff Friction = avg hours between agent marking done and human confirming."""
    board, todo, wip, done = await _setup_board_with_columns(db_session, test_workspace, test_user)

    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    card_id = uuid.uuid4()

    db_session.add(Card(
        id=card_id, board_id=board.id, column_id=done.id, title="Done Card",
        position=1024.0, created_by=test_user.id, priority=Priority.medium,
        description="desc",
    ))
    await db_session.flush()

    # Agent moved card to done at t-24h
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        board_id=board.id,
        actor_id=test_user.id,
        agent_id=agent.id,
        entity_type=ActivityEntityType.card,
        entity_id=card_id,
        action=ActivityAction.moved,
        summary="Moved to Done",
        changes={"to_column": str(done.id)},
        created_at=now - timedelta(hours=24),
    ))
    # Human confirmed (moved/updated without agent_id) at t-12h
    db_session.add(Activity(
        workspace_id=test_workspace.id,
        board_id=board.id,
        actor_id=test_user.id,
        entity_type=ActivityEntityType.card,
        entity_id=card_id,
        action=ActivityAction.updated,
        summary="Human confirmed",
        created_at=now - timedelta(hours=12),
    ))
    await db_session.flush()

    service = BoardHealthService(db_session)
    health = await service.get_health(board.id, test_workspace.id)

    assert health.handoff_friction_hours is not None
    # 24h - 12h = 12h gap
    assert abs(health.handoff_friction_hours - 12.0) < 1.0


async def test_health_handoff_friction_no_agent_moves(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Handoff friction is None when no agent-initiated moves exist."""
    board, todo, wip, done = await _setup_board_with_columns(db_session, test_workspace, test_user)

    db_session.add(Card(
        board_id=board.id, column_id=todo.id, title="T1",
        position=1024.0, created_by=test_user.id, priority=Priority.medium,
        description="desc",
    ))
    await db_session.flush()

    service = BoardHealthService(db_session)
    health = await service.get_health(board.id, test_workspace.id)
    assert health.handoff_friction_hours is None


async def test_health_includes_reversion_rate(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Reversion Rate = cards moved backward / total moves in last 30 days."""
    board, todo, wip, done = await _setup_board_with_columns(db_session, test_workspace, test_user)

    now = datetime.now(timezone.utc)
    card_id = uuid.uuid4()

    db_session.add(Card(
        id=card_id, board_id=board.id, column_id=wip.id, title="Reverted Card",
        position=1024.0, created_by=test_user.id, priority=Priority.medium,
        description="desc",
    ))
    await db_session.flush()

    # Forward move: To Do → In Progress
    db_session.add(Activity(
        workspace_id=test_workspace.id, board_id=board.id,
        actor_id=test_user.id, entity_type=ActivityEntityType.card,
        entity_id=card_id, action=ActivityAction.moved,
        summary="Moved forward",
        changes={
            "column_id": {"old": str(todo.id), "new": str(wip.id)},
            "from_column": "To Do", "to_column": "In Progress",
        },
        created_at=now - timedelta(days=5),
    ))
    # Forward move: In Progress → Done
    db_session.add(Activity(
        workspace_id=test_workspace.id, board_id=board.id,
        actor_id=test_user.id, entity_type=ActivityEntityType.card,
        entity_id=card_id, action=ActivityAction.moved,
        summary="Moved to done",
        changes={
            "column_id": {"old": str(wip.id), "new": str(done.id)},
            "from_column": "In Progress", "to_column": "Done",
        },
        created_at=now - timedelta(days=4),
    ))
    # Backward move (reversion): Done → In Progress
    db_session.add(Activity(
        workspace_id=test_workspace.id, board_id=board.id,
        actor_id=test_user.id, entity_type=ActivityEntityType.card,
        entity_id=card_id, action=ActivityAction.moved,
        summary="Reverted",
        changes={
            "column_id": {"old": str(done.id), "new": str(wip.id)},
            "from_column": "Done", "to_column": "In Progress",
        },
        created_at=now - timedelta(days=3),
    ))
    await db_session.flush()

    service = BoardHealthService(db_session)
    health = await service.get_health(board.id, test_workspace.id)

    assert health.reversion_rate is not None
    # 1 backward / 3 total = 0.333
    assert abs(health.reversion_rate - 0.333) < 0.01


async def test_health_reversion_rate_no_moves(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    """Reversion rate is None when there are no moves."""
    board, todo, wip, done = await _setup_board_with_columns(db_session, test_workspace, test_user)

    db_session.add(Card(
        board_id=board.id, column_id=todo.id, title="T1",
        position=1024.0, created_by=test_user.id, priority=Priority.medium,
        description="desc",
    ))
    await db_session.flush()

    service = BoardHealthService(db_session)
    health = await service.get_health(board.id, test_workspace.id)
    assert health.reversion_rate is None
