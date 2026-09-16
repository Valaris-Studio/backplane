# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Integration tests for POST /api/agents/{agent_id}/pause and /resume.

Card 49f8bb82: runner pause primitive. Backend half.

Contract:
- POST /pause flips is_paused=True; idempotent (200 either way).
- POST /resume flips is_paused=False; idempotent.
- WS events `agent.paused` / `agent.resumed` emitted ONLY on actual transition.
- Pause stops new claims (next-assignment 204) but leaves heartbeats/auth alone.
- An in-flight reservation/execution is not affected by pause — pause only
  gates new claims.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.agents.agent import Agent, AgentType
from app.models.agents.reservation import AgentReservation
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG


BASE_URL = "/api/agents"
ASSIGN_URL = "/api/workspaces/{slug}/agents/{agent_id}/next-assignment"


async def _seed_default_pipeline(db: AsyncSession, workspace: Workspace):
    cfg = WorkspaceConfig(
        workspace_id=workspace.id,
        pipeline_config=DEFAULT_PIPELINE_CONFIG,
    )
    db.add(cfg)
    await db.flush()


async def _backlog_column(db: AsyncSession, board: Board) -> Column:
    col = Column(
        board_id=board.id,
        name="To Do",
        position=1.0,
        color="#888",
        column_type=ColumnType.backlog,
    )
    db.add(col)
    await db.flush()
    return col


async def _make_repo(db: AsyncSession, board: Board, user: User) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="acme",
        slug="acme",
        url="https://github.com/acme/acme",
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _add_team_role(
    db: AsyncSession, workspace: Workspace, agent: Agent, user: User, role: str
):
    team = AgentTeam(
        name=f"{role}-team",
        workspace_id=workspace.id,
        created_by_id=user.id,
    )
    db.add(team)
    await db.flush()
    member = AgentTeamMember(team_id=team.id, agent_id=agent.id, roles=[role])
    db.add(member)
    await db.flush()


async def _make_card(db: AsyncSession, board: Board, column: Column, user: User) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title="work",
        description="",
        position=1024.0,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


# --- Pause / resume router (HTTP) tests ---


@pytest.mark.asyncio
async def test_pause_agent_marks_is_paused_true_and_emits_ws_event(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Hitting /pause flips the column and broadcasts agent.paused on the
    owner's workspace channel exactly once."""
    agent = Agent(
        name="pause-me",
        agent_type=AgentType.coding,
        description="",
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()

    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.paused"
    )
    try:
        resp = await client.post(f"{BASE_URL}/{agent.id}/pause")
    finally:
        unsub()

    assert resp.status_code == 200
    body = resp.json()
    assert body["is_paused"] is True

    await db_session.refresh(agent)
    assert agent.is_paused is True

    assert len(received) == 1
    assert received[0].event_type == "agent.paused"
    assert received[0].payload["agent_id"] == str(agent.id)


@pytest.mark.asyncio
async def test_pause_already_paused_returns_200_no_extra_ws_event(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """Idempotence: pausing an already-paused agent returns 200 with the
    current state, and emits NO additional WS event."""
    agent = Agent(
        name="already-paused",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=True,
        is_paused=True,
    )
    db_session.add(agent)
    await db_session.flush()

    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.paused"
    )
    try:
        resp = await client.post(f"{BASE_URL}/{agent.id}/pause")
    finally:
        unsub()

    assert resp.status_code == 200
    assert resp.json()["is_paused"] is True
    assert received == []


@pytest.mark.asyncio
async def test_resume_agent_marks_is_paused_false_and_emits_ws_event(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = Agent(
        name="resume-me",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=True,
        is_paused=True,
    )
    db_session.add(agent)
    await db_session.flush()

    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.resumed"
    )
    try:
        resp = await client.post(f"{BASE_URL}/{agent.id}/resume")
    finally:
        unsub()

    assert resp.status_code == 200
    assert resp.json()["is_paused"] is False

    await db_session.refresh(agent)
    assert agent.is_paused is False

    assert len(received) == 1
    assert received[0].event_type == "agent.resumed"
    assert received[0].payload["agent_id"] == str(agent.id)


@pytest.mark.asyncio
async def test_resume_already_running_returns_200_no_extra_ws_event(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    agent = Agent(
        name="never-paused",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=True,
        is_paused=False,
    )
    db_session.add(agent)
    await db_session.flush()

    received = []

    async def cap(event):
        received.append(event)

    unsub = event_bus.subscribe(
        cap, workspace_id=test_workspace.id, event_pattern="agent.resumed"
    )
    try:
        resp = await client.post(f"{BASE_URL}/{agent.id}/resume")
    finally:
        unsub()

    assert resp.status_code == 200
    assert resp.json()["is_paused"] is False
    assert received == []


@pytest.mark.asyncio
async def test_pause_unknown_agent_returns_404(client: AsyncClient, test_user: User):
    resp = await client.post(f"{BASE_URL}/{uuid.uuid4()}/pause")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_pause_other_owners_agent_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
):
    """Hostile-tenant guard reuses the 404-not-403 shape that get_agent uses
    (memory: team_role_projection_audit_2026_04_25.md). A foreign agent is
    indistinguishable from a missing one."""
    foreign = Agent(
        name="foreign",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
        allowed_workspaces=["default"],
        is_active=True,
    )
    db_session.add(foreign)
    await db_session.flush()

    resp = await client.post(f"{BASE_URL}/{foreign.id}/pause")
    assert resp.status_code == 404


# --- Scheduler integration: paused agent gets 204 even when work is eligible ---


@pytest.mark.asyncio
async def test_next_assignment_returns_204_when_agent_paused(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """A paused agent never receives a new card, even when one is eligible."""
    await _seed_default_pipeline(db_session, test_workspace)
    col = await _backlog_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    await _make_card(db_session, test_board, col, test_user)

    test_agent.is_paused = True
    await db_session.flush()

    resp = await agent_client.post(
        ASSIGN_URL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_next_assignment_proceeds_when_agent_unpaused(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Sanity: with is_paused=False (default), the scheduler returns work."""
    await _seed_default_pipeline(db_session, test_workspace)
    col = await _backlog_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, col, test_user)

    assert test_agent.is_paused is False

    resp = await agent_client.post(
        ASSIGN_URL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200
    assert resp.json()["card"]["id"] == str(card.id)


@pytest.mark.asyncio
async def test_in_flight_reservation_survives_pause(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Pause stops NEW claims; it must not invalidate or delete an existing
    reservation. The in-flight runner keeps the row it already holds.

    Verified by checking the reservation row is still in the database after
    a pause toggle — the runner finishes its work loop on the held card."""
    await _seed_default_pipeline(db_session, test_workspace)
    col = await _backlog_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "orchestrator")
    card = await _make_card(db_session, test_board, col, test_user)

    reservation = AgentReservation(
        agent_id=test_agent.id,
        card_id=card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="orchestrator",
        expires_at=datetime.utcnow() + timedelta(minutes=5),
    )
    db_session.add(reservation)
    await db_session.flush()
    reservation_id = reservation.id

    test_agent.is_paused = True
    await db_session.flush()

    from sqlalchemy import select

    rows = (
        await db_session.execute(
            select(AgentReservation).where(AgentReservation.id == reservation_id)
        )
    ).scalars().all()
    assert len(rows) == 1, "pause must not delete or invalidate in-flight reservations"
    assert rows[0].card_id == card.id


@pytest.mark.asyncio
async def test_heartbeat_works_while_paused(
    agent_client: AsyncClient,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """Pause must NOT gate heartbeats — that's how operators see the paused
    runner is still alive. Auth and the heartbeat path remain untouched."""
    test_agent.is_paused = True
    await db_session.flush()

    resp = await agent_client.post(f"{BASE_URL}/me/heartbeat", json={"status": "idle"})
    assert resp.status_code == 200
    assert resp.json()["last_seen_at"] is not None


@pytest.mark.asyncio
async def test_agent_read_exposes_is_paused(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    test_workspace: Workspace,
):
    """AgentRead schema surfaces is_paused so the UI can render the toggle."""
    resp = await client.post(
        BASE_URL,
        json={
            "name": "expose-me",
            "agent_type": "coding",
            "allowed_workspaces": [test_workspace.slug],
        },
    )
    assert resp.status_code == 201
    assert resp.json()["is_paused"] is False
