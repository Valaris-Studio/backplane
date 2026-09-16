# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Metrics liveness vs in-flight promotion — age-aware semantics.

History: the original promotion had no ceiling (any in-flight row → alive
forever, card a32550aa), then a first fix capped it at the stale threshold
(stale → alive, never offline). The field falsified the cap on 2026-08-09:
loop runners do not heartbeat DURING an iteration (only between ticks), so a
40-minute iteration ages the runner past the 600s offline threshold while it
is genuinely working — the board showed "LOOP RUNNING" beside its own runner
badged OFFLINE.

Current contract: an in-flight execution is evidence of life while it is
still within a plausible runtime (its started_at proves the runner was alive
then, and in-execution heartbeat silence is expected) — but an in-flight row
OLDER than any sane execution is a wedge left by a dead process and promotes
nothing. The window is metrics.INFLIGHT_EVIDENCE_MAX_AGE.
"""

from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.services.metrics import INFLIGHT_EVIDENCE_MAX_AGE, MetricsService
from app.utils import utcnow


async def _agent_with_inflight(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    name: str,
    last_seen_delta: timedelta,
    inflight_started_delta: timedelta,
) -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        created_by_id=user.id,
        allowed_workspaces=[workspace.slug],
        last_seen_at=utcnow() - last_seen_delta,
    )
    db.add(agent)
    await db.flush()
    db.add(
        AgentExecution(
            agent_id=agent.id,
            workspace_id=workspace.id,
            action="loop_iteration",
            status=ExecutionStatus.running,
            started_at=utcnow() - inflight_started_delta,
            input_summary="in-flight",
        )
    )
    await db.flush()
    return agent


async def test_agent_metrics_wedged_inflight_row_does_not_resurrect_offline(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """An in-flight row older than any plausible runtime is a wedge — the
    execution never completed BECAUSE the runner died — and must not promote.
    Heartbeat truth (20 min silent → offline) wins."""
    await _agent_with_inflight(
        db_session,
        test_workspace,
        test_user,
        name="dead-runner",
        last_seen_delta=timedelta(minutes=20),
        inflight_started_delta=INFLIGHT_EVIDENCE_MAX_AGE + timedelta(minutes=5),
    )

    metrics = await MetricsService(db_session).get_agent_metrics(test_workspace.id)
    assert len(metrics.agents) == 1
    agent_metric = metrics.agents[0]
    assert agent_metric.liveness != "alive", (
        "a wedged in-flight execution row promoted a 20-minutes-silent agent "
        f"to alive (got {agent_metric.liveness!r})"
    )
    assert agent_metric.liveness == "offline"


async def test_agent_metrics_fresh_inflight_promotes_past_offline_threshold(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """The 2026-08-09 field case: heartbeat 20 min stale (loop runners are
    silent during an iteration) but the iteration started 5 min ago — the
    execution start IS proof of life, so the runner reads alive, not offline."""
    await _agent_with_inflight(
        db_session,
        test_workspace,
        test_user,
        name="mid-iteration-runner",
        last_seen_delta=timedelta(minutes=20),
        inflight_started_delta=timedelta(minutes=5),
    )

    metrics = await MetricsService(db_session).get_agent_metrics(test_workspace.id)
    assert len(metrics.agents) == 1
    agent_metric = metrics.agents[0]
    assert agent_metric.liveness == "alive"
    assert agent_metric.working is True


async def test_agent_metrics_fresh_heartbeat_with_inflight_alive_and_working(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Companion green pin: fresh heartbeat plus fresh in-flight execution
    reads alive and working — the everyday case stays intact."""
    await _agent_with_inflight(
        db_session,
        test_workspace,
        test_user,
        name="busy-runner",
        last_seen_delta=timedelta(seconds=10),
        inflight_started_delta=timedelta(seconds=10),
    )

    metrics = await MetricsService(db_session).get_agent_metrics(test_workspace.id)
    assert len(metrics.agents) == 1
    agent_metric = metrics.agents[0]
    assert agent_metric.liveness == "alive"
    assert agent_metric.working is True
