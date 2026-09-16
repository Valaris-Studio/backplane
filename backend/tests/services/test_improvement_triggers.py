# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.services.improvement_triggers import ImprovementTriggerService


async def test_detect_repeated_failures(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    # 3 failures of same action in 24h
    for _ in range(3):
        db_session.add(AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            action="deploy",
            status=ExecutionStatus.failed,
        ))
    await db_session.flush()

    service = ImprovementTriggerService(db_session)
    triggers = await service.detect_triggers(test_workspace.id)
    repeated = [t for t in triggers if t.trigger_type == "repeated_failure"]
    assert len(repeated) == 1
    assert repeated[0].context["action"] == "deploy"
    assert repeated[0].context["failure_count"] == 3
    assert repeated[0].severity == "high"


async def test_no_repeated_failures_under_threshold(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = Agent(name="coder", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    # Only 2 failures — below threshold
    for _ in range(2):
        db_session.add(AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            action="deploy",
            status=ExecutionStatus.failed,
        ))
    await db_session.flush()

    service = ImprovementTriggerService(db_session)
    triggers = await service.detect_triggers(test_workspace.id)
    repeated = [t for t in triggers if t.trigger_type == "repeated_failure"]
    assert len(repeated) == 0


async def test_detect_high_error_rate(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = Agent(name="flaky", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    # 4 failed + 1 completed = 80% failure, 5 total
    for _ in range(4):
        db_session.add(AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="implement", status=ExecutionStatus.failed,
        ))
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="implement", status=ExecutionStatus.completed,
    ))
    await db_session.flush()

    service = ImprovementTriggerService(db_session)
    triggers = await service.detect_triggers(test_workspace.id)
    high_error = [t for t in triggers if t.trigger_type == "high_error_rate"]
    assert len(high_error) == 1
    assert high_error[0].context["failure_rate"] == 0.8


async def test_no_high_error_rate_with_low_failures(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = Agent(name="reliable", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    # 1 failed + 4 completed = 20% failure
    db_session.add(AgentExecution(
        agent_id=agent.id, workspace_id=test_workspace.id,
        action="implement", status=ExecutionStatus.failed,
    ))
    for _ in range(4):
        db_session.add(AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="implement", status=ExecutionStatus.completed,
        ))
    await db_session.flush()

    service = ImprovementTriggerService(db_session)
    triggers = await service.detect_triggers(test_workspace.id)
    high_error = [t for t in triggers if t.trigger_type == "high_error_rate"]
    assert len(high_error) == 0


async def test_detect_slow_executions(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = Agent(name="slow", agent_type=AgentType.coding, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    for _ in range(3):
        db_session.add(AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="heavy_analysis", status=ExecutionStatus.completed,
            duration_seconds=180.0,
        ))
    await db_session.flush()

    service = ImprovementTriggerService(db_session)
    triggers = await service.detect_triggers(test_workspace.id)
    slow = [t for t in triggers if t.trigger_type == "slow_execution"]
    assert len(slow) == 1
    assert slow[0].context["action"] == "heavy_analysis"
    assert slow[0].context["avg_duration"] == 180.0


async def test_rate_limiting(
    db_session: AsyncSession, test_user: User, test_workspace: Workspace
):
    agent = Agent(name="improver", agent_type=AgentType.improver, created_by_id=test_user.id)
    db_session.add(agent)
    await db_session.flush()

    service = ImprovementTriggerService(db_session)

    # No improvements yet — should be allowed
    assert await service.can_run_improvement(test_workspace.id) is True

    # Add 3 improvement executions today
    for _ in range(3):
        db_session.add(AgentExecution(
            agent_id=agent.id, workspace_id=test_workspace.id,
            action="self_improvement", status=ExecutionStatus.completed,
        ))
    await db_session.flush()

    # Should be rate-limited now
    assert await service.can_run_improvement(test_workspace.id) is False
    assert await service.count_improvement_prs_today(test_workspace.id) == 3


async def test_detect_triggers_empty_workspace(
    db_session: AsyncSession, test_workspace: Workspace
):
    service = ImprovementTriggerService(db_session)
    triggers = await service.detect_triggers(test_workspace.id)
    assert triggers == []
