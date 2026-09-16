# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Parked is runner truth, not a client-side guess (card 442ff0f2). RED phase.

Before this card the backend's state ladder ended at `waiting`, and the chip
inferred "parked" from `waiting && !actionable` — a readiness guess. A runner
that had just died and a runner deliberately sleeping off its park backoff
produced the SAME wire state, because readiness (a board property) was doing
the work that only the runner knows.

What is pinned here:

  parked — enabled, no in-flight iteration, and at least one BOUND agent that
           is heartbeat-`alive` AND whose last heartbeat reported
           loop_state='parked' FOR THIS BOARD. `park_reason` rides along.

Precedence is deliberate and asserted below:
  * `off` and `running` still win — a parked claim from a stale tick must
    never mask an in-flight iteration or a disabled loop.
  * a parked claim from an agent bound to a DIFFERENT board is ignored: the
    claim is scoped by the reported health_loop_board_id, the same doctrine
    that keeps `bound` derived from AgentTeam.board_id rather than from
    health_current_board_id.
  * a parked claim from a STALE agent decays: liveness is still the gate, so
    a killed runner falls back to `unattended` exactly as today. This is the
    whole point of the card — parked and dead stop being conflatable.

Old runners that heartbeat without the loop fields must behave EXACTLY as
before (no 422, no state change); that round-trip is pinned in
tests/routers/agents/test_agent_heartbeat_loop_fields.py.
"""

from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.utils import utcnow


BASE = "/api/workspaces/default/boards"

ENABLED_PUT_BODY = {
    "enabled": True,
    "provider": "codex-cli",
    "model": "premium",
    "system_prompt": "You are the maintenance agent.",
    "loop_prompt": "Iteration {{.Iteration}}: make progress.",
    "tools": [],
    "max_iterations": 10,
    "iteration_delay_seconds": 5,
    "iteration_timeout_seconds": 600,
    "budget_usd": 7.5,
    "max_consecutive_failures": 2,
}


def _status_url(board: Board) -> str:
    return f"{BASE}/{board.id}/loop/status"


async def _enable_loop(client: AsyncClient, board: Board) -> None:
    resp = await client.put(f"{BASE}/{board.id}/loop", json=ENABLED_PUT_BODY)
    assert resp.status_code == 200, resp.text


async def _make_team(
    db: AsyncSession, workspace: Workspace, board: Board, user: User
) -> AgentTeam:
    team = AgentTeam(
        name="loop crew",
        workspace_id=workspace.id,
        board_id=board.id,
        created_by_id=user.id,
    )
    db.add(team)
    await db.flush()
    return team


async def _bind_agent(
    db: AsyncSession,
    team: AgentTeam,
    user: User,
    *,
    name: str,
    last_seen_at: datetime | None,
    **health,
) -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        created_by_id=user.id,
        is_active=True,
        last_seen_at=last_seen_at,
        **health,
    )
    db.add(agent)
    await db.flush()
    db.add(AgentTeamMember(team_id=team.id, agent_id=agent.id))
    await db.flush()
    return agent


async def test_loop_status_parked_when_alive_agent_reports_parked(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The headline: runner-reported park replaces the readiness guess."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session,
        team,
        test_user,
        name="napping",
        last_seen_at=utcnow(),
        health_loop_board_id=str(test_board.id),
        health_loop_state="parked",
        health_loop_park_reason="nothing actionable",
    )

    resp = await client.get(_status_url(test_board))
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["state"] == "parked"
    assert data["park_reason"] == "nothing actionable"
    assert data["alive_agent_count"] == 1


async def test_loop_status_ticking_agent_stays_waiting(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A runner between iterations reports `ticking` — that is `waiting`, and
    park_reason stays null so the chip has nothing to misreport."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session,
        team,
        test_user,
        name="busy",
        last_seen_at=utcnow(),
        health_loop_board_id=str(test_board.id),
        health_loop_state="ticking",
    )

    resp = await client.get(_status_url(test_board))
    data = resp.json()
    assert data["state"] == "waiting"
    assert data["park_reason"] is None


async def test_loop_status_stale_agent_parked_claim_decays_to_unattended(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A killed runner's LAST heartbeat still says `parked` forever. Liveness
    is what expires the claim — otherwise the card's own premise (parked and
    dead must be distinguishable) would be inverted into a permanent lie."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session,
        team,
        test_user,
        name="deceased",
        last_seen_at=utcnow() - timedelta(hours=2),
        health_loop_board_id=str(test_board.id),
        health_loop_state="parked",
        health_loop_park_reason="nothing actionable",
    )

    resp = await client.get(_status_url(test_board))
    data = resp.json()
    assert data["state"] == "unattended"
    assert data["park_reason"] is None
    assert data["alive_agent_count"] == 0


async def test_loop_status_parked_claim_for_other_board_ignored(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """Board attribution: an agent bound here but looping SOMEWHERE ELSE is
    not parked on this board. It is alive and idle here — `waiting`."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session,
        team,
        test_user,
        name="elsewhere",
        last_seen_at=utcnow(),
        health_loop_board_id="11111111-1111-1111-1111-111111111111",
        health_loop_state="parked",
        health_loop_park_reason="nothing actionable",
    )

    resp = await client.get(_status_url(test_board))
    data = resp.json()
    assert data["state"] == "waiting"
    assert data["park_reason"] is None


async def test_loop_status_inflight_iteration_beats_stale_parked_claim(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """`running` outranks a parked claim: the heartbeat that set `parked` is
    by definition older than the iteration currently in flight."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    agent = await _bind_agent(
        db_session,
        team,
        test_user,
        name="woken",
        last_seen_at=utcnow(),
        health_loop_board_id=str(test_board.id),
        health_loop_state="parked",
        health_loop_park_reason="nothing actionable",
    )
    db_session.add(
        AgentExecution(
            agent_id=agent.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            action="loop_iteration",
            status=ExecutionStatus.running,
            started_at=utcnow(),
            input_summary="loop iteration",
        )
    )
    await db_session.flush()

    resp = await client.get(_status_url(test_board))
    data = resp.json()
    assert data["state"] == "running"
    assert data["park_reason"] is None


async def test_loop_status_disabled_loop_beats_parked_claim(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """`off` wins over everything, unchanged by this card."""
    await _enable_loop(client, test_board)
    team = await _make_team(db_session, test_workspace, test_board, test_user)
    await _bind_agent(
        db_session,
        team,
        test_user,
        name="napping",
        last_seen_at=utcnow(),
        health_loop_board_id=str(test_board.id),
        health_loop_state="parked",
        health_loop_park_reason="nothing actionable",
    )
    resp = await client.patch(
        f"{BASE}/{test_board.id}/loop/state",
        json={"enabled": False, "reason": "operator stop"},
    )
    assert resp.status_code == 200, resp.text

    data = (await client.get(_status_url(test_board))).json()
    assert data["state"] == "off"
    assert data["park_reason"] is None


async def test_loop_status_park_reason_key_always_present(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    """park_reason is part of the wire object for EVERY state, null when it
    does not apply — an absent key would make the frontend's optional-chaining
    silently correct today and silently wrong the day it is populated."""
    data = (await client.get(_status_url(test_board))).json()
    assert data["state"] == "off"
    assert "park_reason" in data
    assert data["park_reason"] is None
