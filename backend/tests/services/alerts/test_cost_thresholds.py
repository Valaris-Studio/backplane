# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import timedelta
from unittest.mock import AsyncMock, patch

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import COST_THRESHOLD_CROSSED
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.alerts.alert_threshold import AlertMetric, AlertOperator, AlertThreshold
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.alerts.alert_threshold import AlertThresholdService
from app.utils import utcnow


async def _create_agent_with_executions(
    db: AsyncSession,
    user: User,
    workspace: Workspace,
    cost_per_execution: float,
    count: int,
    days_ago: int = 0,
) -> Agent:
    """Helper to create an agent with executions at a specific cost."""
    agent = Agent(
        name="cost-test-agent",
        agent_type=AgentType.coding,
        description="test",
        created_by_id=user.id,
        is_active=True,
        allowed_workspaces=f'["{workspace.slug}"]',
    )
    db.add(agent)
    await db.flush()

    base_time = utcnow() - timedelta(days=days_ago)
    for i in range(count):
        execution = AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            action="test-action",
            status=ExecutionStatus.completed,
            started_at=base_time + timedelta(hours=i),
            cost_usd=cost_per_execution,
            tokens_used=1000,
        )
        db.add(execution)
    await db.flush()
    return agent


async def test_evaluate_cost_threshold_7d_triggered(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Cost threshold for 7d spend > $5 should trigger when total cost exceeds."""
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=2.0, count=3, days_ago=3,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="High weekly spend",
        metric=AlertMetric.cost_usd_7d,
        operator=AlertOperator.gt,
        value=5.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_cost_thresholds(test_workspace.id)

    assert len(triggered) == 1
    assert triggered[0]["name"] == "High weekly spend"
    assert triggered[0]["current_value"] == 6.0
    assert triggered[0]["metric"] == "cost_usd_7d"


async def test_evaluate_cost_threshold_7d_not_triggered(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Cost threshold should NOT trigger when cost is below target."""
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=1.0, count=2, days_ago=3,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="High weekly spend",
        metric=AlertMetric.cost_usd_7d,
        operator=AlertOperator.gt,
        value=5.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_cost_thresholds(test_workspace.id)

    assert len(triggered) == 0


async def test_evaluate_cost_threshold_30d_triggered(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Cost threshold for 30d should include executions from the full 30-day window."""
    # Executions 20 days ago (outside 7d window, inside 30d)
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=5.0, count=3, days_ago=20,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="High monthly spend",
        metric=AlertMetric.cost_usd_30d,
        operator=AlertOperator.gte,
        value=15.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_cost_thresholds(test_workspace.id)

    assert len(triggered) == 1
    assert triggered[0]["current_value"] == 15.0


async def test_evaluate_cost_threshold_skips_inactive(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Inactive cost thresholds should be skipped."""
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=10.0, count=5, days_ago=1,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="Disabled cost alert",
        metric=AlertMetric.cost_usd_7d,
        operator=AlertOperator.gt,
        value=1.0,
        is_active=False,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_cost_thresholds(test_workspace.id)

    assert len(triggered) == 0


async def test_evaluate_cost_threshold_old_executions_excluded_from_7d(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Executions older than 7 days should not count toward cost_usd_7d."""
    # All executions 10 days ago -- outside 7d window
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=10.0, count=5, days_ago=10,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="Weekly cost alert",
        metric=AlertMetric.cost_usd_7d,
        operator=AlertOperator.gt,
        value=1.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    service = AlertThresholdService(db_session)
    triggered = await service.evaluate_cost_thresholds(test_workspace.id)

    assert len(triggered) == 0


async def test_cost_threshold_emits_event(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Triggered cost thresholds should publish COST_THRESHOLD_CROSSED event."""
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=3.0, count=4, days_ago=2,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="Cost event alert",
        metric=AlertMetric.cost_usd_7d,
        operator=AlertOperator.gt,
        value=10.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    received_events = []

    async def capture_event(event):
        received_events.append(event)

    unsub = event_bus.subscribe(
        capture_event,
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )

    try:
        service = AlertThresholdService(db_session)
        triggered = await service.evaluate_cost_thresholds(test_workspace.id)

        assert len(triggered) == 1
        assert len(received_events) == 1
        assert received_events[0].event_type == COST_THRESHOLD_CROSSED
        assert received_events[0].payload["metric"] == "cost_usd_7d"
        assert received_events[0].payload["current_value"] == 12.0
        assert received_events[0].payload["target_value"] == 10.0
    finally:
        unsub()


async def test_cost_threshold_no_event_when_not_triggered(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """No event should be published when cost is below threshold."""
    await _create_agent_with_executions(
        db_session, test_user, test_workspace,
        cost_per_execution=1.0, count=2, days_ago=1,
    )

    db_session.add(AlertThreshold(
        workspace_id=test_workspace.id,
        board_id=None,
        name="Cost event alert",
        metric=AlertMetric.cost_usd_7d,
        operator=AlertOperator.gt,
        value=100.0,
        created_by_id=test_user.id,
    ))
    await db_session.flush()

    received_events = []

    async def capture_event(event):
        received_events.append(event)

    unsub = event_bus.subscribe(
        capture_event,
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )

    try:
        service = AlertThresholdService(db_session)
        triggered = await service.evaluate_cost_thresholds(test_workspace.id)

        assert len(triggered) == 0
        assert len(received_events) == 0
    finally:
        unsub()
