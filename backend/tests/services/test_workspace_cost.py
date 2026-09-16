# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace-level cost circuit breaker — rolling-window sum + breaker eval.

Card e244867f. Backend tracks per-workspace cost-rate; when configured
threshold crosses, emits cost.threshold_crossed and the runtime can pause
/next-assignment. Operator clears via the resume endpoint.
"""

from __future__ import annotations

from datetime import timedelta

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import COST_THRESHOLD_CROSSED
from app.models.agents.agent import Agent
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.models.workspace_config import WorkspaceConfig
from app.utils import utcnow


async def _seed_execution(
    db: AsyncSession,
    *,
    workspace: Workspace,
    agent: Agent,
    cost_usd: float,
    minutes_ago: float,
):
    started_at = utcnow() - timedelta(minutes=minutes_ago)
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        action="implement_card",
        status=ExecutionStatus.completed,
        cost_usd=cost_usd,
        started_at=started_at,
    )
    db.add(execution)
    await db.flush()
    return execution


@pytest.mark.asyncio
async def test_workspace_cost_in_window_sums_recent_executions(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import workspace_cost_in_window

    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=5.0, minutes_ago=2)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=5.0, minutes_ago=5)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=100.0, minutes_ago=60)

    total = await workspace_cost_in_window(db_session, test_workspace.id, window_seconds=900)
    assert total == pytest.approx(10.0)


@pytest.mark.asyncio
async def test_workspace_cost_in_window_returns_zero_when_no_executions(
    db_session: AsyncSession, test_workspace: Workspace
):
    from app.services.agents.cost import workspace_cost_in_window
    total = await workspace_cost_in_window(db_session, test_workspace.id)
    assert total == 0.0


@pytest.mark.asyncio
async def test_workspace_cost_in_window_ignores_other_workspaces(
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
    test_agent: Agent,
):
    other_ws = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    db_session.add(WorkspaceMember(
        workspace_id=other_ws.id, user_id=test_user.id, role=WorkspaceRole.owner,
    ))
    await db_session.flush()

    await _seed_execution(db_session, workspace=other_ws, agent=test_agent,
                          cost_usd=42.0, minutes_ago=1)

    from app.services.agents.cost import workspace_cost_in_window
    total = await workspace_cost_in_window(db_session, test_workspace.id)
    assert total == 0.0


@pytest.mark.asyncio
async def test_evaluate_breaker_below_threshold_returns_clear(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import (
        evaluate_circuit_breaker,
        reset_breaker_dedupe,
    )
    reset_breaker_dedupe(test_workspace.id)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=5.0, minutes_ago=1)

    captured: list = []
    unsub = event_bus.subscribe(
        lambda evt: captured.append(evt) or _async_noop(),
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )
    try:
        result = await evaluate_circuit_breaker(
            db_session,
            workspace_id=test_workspace.id,
            breaker_config={
                "enabled": True,
                "threshold_usd_per_15min": 20.0,
                "action": "pause",
            },
        )
    finally:
        unsub()

    assert result.triggered is False
    assert captured == []


async def _async_noop():
    return None


@pytest.mark.asyncio
async def test_evaluate_breaker_above_threshold_pauses_and_emits(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import (
        evaluate_circuit_breaker,
        reset_breaker_dedupe,
    )
    reset_breaker_dedupe(test_workspace.id)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=30.0, minutes_ago=1)

    captured: list = []

    async def _handler(evt):
        captured.append(evt)

    unsub = event_bus.subscribe(
        _handler,
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )
    try:
        result = await evaluate_circuit_breaker(
            db_session,
            workspace_id=test_workspace.id,
            breaker_config={
                "enabled": True,
                "threshold_usd_per_15min": 20.0,
                "action": "pause",
            },
        )
    finally:
        unsub()

    assert result.triggered is True
    assert result.action == "pause"
    assert result.current_usd == pytest.approx(30.0)
    assert result.threshold_usd == pytest.approx(20.0)
    assert len(captured) == 1
    payload = captured[0].payload
    assert payload["current_usd"] == pytest.approx(30.0)
    assert payload["threshold_usd"] == pytest.approx(20.0)
    assert payload["action"] == "pause"


@pytest.mark.asyncio
async def test_evaluate_breaker_disabled_returns_clear(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import (
        evaluate_circuit_breaker,
        reset_breaker_dedupe,
    )
    reset_breaker_dedupe(test_workspace.id)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=99999.0, minutes_ago=1)

    result = await evaluate_circuit_breaker(
        db_session,
        workspace_id=test_workspace.id,
        breaker_config={
            "enabled": False,
            "threshold_usd_per_15min": 0.01,
            "action": "pause",
        },
    )
    assert result.triggered is False


@pytest.mark.asyncio
async def test_evaluate_breaker_no_config_returns_clear(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import (
        evaluate_circuit_breaker,
        reset_breaker_dedupe,
    )
    reset_breaker_dedupe(test_workspace.id)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=99999.0, minutes_ago=1)

    result = await evaluate_circuit_breaker(
        db_session,
        workspace_id=test_workspace.id,
        breaker_config=None,
    )
    assert result.triggered is False


@pytest.mark.asyncio
async def test_evaluate_breaker_idempotent_within_cooldown(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import (
        evaluate_circuit_breaker,
        reset_breaker_dedupe,
    )
    reset_breaker_dedupe(test_workspace.id)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=30.0, minutes_ago=1)

    captured: list = []

    async def _handler(evt):
        captured.append(evt)

    unsub = event_bus.subscribe(
        _handler,
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )
    try:
        breaker = {
            "enabled": True,
            "threshold_usd_per_15min": 20.0,
            "action": "pause",
        }
        first = await evaluate_circuit_breaker(
            db_session, workspace_id=test_workspace.id, breaker_config=breaker,
        )
        second = await evaluate_circuit_breaker(
            db_session, workspace_id=test_workspace.id, breaker_config=breaker,
        )
    finally:
        unsub()

    assert first.triggered is True
    assert second.triggered is True
    assert len(captured) == 1, f"expected 1 emission, got {len(captured)}"


@pytest.mark.asyncio
async def test_reset_breaker_dedupe_allows_re_emission(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    from app.services.agents.cost import (
        evaluate_circuit_breaker,
        reset_breaker_dedupe,
    )
    reset_breaker_dedupe(test_workspace.id)
    await _seed_execution(db_session, workspace=test_workspace, agent=test_agent,
                          cost_usd=30.0, minutes_ago=1)

    captured: list = []

    async def _handler(evt):
        captured.append(evt)

    unsub = event_bus.subscribe(
        _handler,
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )
    try:
        breaker = {
            "enabled": True,
            "threshold_usd_per_15min": 20.0,
            "action": "pause",
        }
        await evaluate_circuit_breaker(
            db_session, workspace_id=test_workspace.id, breaker_config=breaker,
        )
        reset_breaker_dedupe(test_workspace.id)
        await evaluate_circuit_breaker(
            db_session, workspace_id=test_workspace.id, breaker_config=breaker,
        )
    finally:
        unsub()

    assert len(captured) == 2


@pytest.mark.asyncio
async def test_execution_complete_evaluates_breaker(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    """When an execution finishes with cost that trips the workspace
    breaker, ExecutionService.update_execution should fire cost.threshold_crossed."""
    from app.models.agents.execution import AgentExecution, ExecutionStatus
    from app.schemas.agents.execution import ExecutionUpdate
    from app.services.agents.cost import reset_breaker_dedupe
    from app.services.agents.execution import ExecutionService

    db_session.add(WorkspaceConfig(
        workspace_id=test_workspace.id,
        cost_circuit_breaker={
            "enabled": True,
            "threshold_usd_per_15min": 0.01,
            "action": "pause",
        },
    ))
    await db_session.flush()

    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        action="implement_card",
        status=ExecutionStatus.started,
    )
    db_session.add(execution)
    await db_session.flush()

    captured: list = []

    async def _handler(evt):
        captured.append(evt)

    unsub = event_bus.subscribe(
        _handler,
        workspace_id=test_workspace.id,
        event_pattern=COST_THRESHOLD_CROSSED,
    )
    reset_breaker_dedupe(test_workspace.id)
    try:
        service = ExecutionService(db_session)
        await service.update_execution(
            test_agent.id,
            execution.id,
            ExecutionUpdate(
                status=ExecutionStatus.completed,
                cost_usd=99.0,
                output_summary="done",
            ),
            user_id=None,
        )
    finally:
        unsub()

    # ExecutionService doesn't filter by user when user_id is None.
    assert len(captured) == 1
    assert captured[0].payload["current_usd"] == pytest.approx(99.0)
