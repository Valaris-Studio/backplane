# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Scheduler must never hand out cards on a frozen board.

RED phase, driven through the next-assignment endpoint like
tests/services/test_scheduler_filters.py (router -> AssignmentService ->
candidate query, no SQL re-mocking):

  - Two boards, one frozen: the frozen board's card is skipped even when it
    sorts first (position asc).
  - Only a frozen board eligible: 204, and no AgentReservation row appears.
  - Reservation re-issue mirror: a live reservation on a board frozen AFTER
    the reserve must not be re-issued (mirrors _reservation_still_eligible,
    same trap as the M-07 freshness split-brain).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.reservation import AgentReservation
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, Priority
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig


URL_TPL = "/api/workspaces/{slug}/agents/{agent_id}/next-assignment"


# --- helpers (mirrors tests/services/test_scheduler_filters.py) --------------


async def _add_team_role(
    db: AsyncSession, workspace: Workspace, agent: Agent, user: User, role: str
):
    team = AgentTeam(
        name=f"{role}-team", workspace_id=workspace.id, created_by_id=user.id
    )
    db.add(team)
    await db.flush()
    db.add(AgentTeamMember(team_id=team.id, agent_id=agent.id, roles=[role]))
    await db.flush()


async def _make_backlog_column(db: AsyncSession, board: Board) -> Column:
    column = Column(
        board_id=board.id,
        name="To Do",
        position=1.0,
        color="#888",
        column_type=ColumnType.backlog,
    )
    db.add(column)
    await db.flush()
    return column


async def _make_repo(db: AsyncSession, board: Board, user: User, slug: str) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name=slug,
        slug=slug,
        url=f"https://github.com/acme/{slug}",
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _make_card(
    db: AsyncSession,
    board: Board,
    column: Column,
    user: User,
    *,
    title: str,
    position: float,
) -> Card:
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title=title,
        position=position,
        priority=Priority.medium,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    return card


async def _seed_implementer_pipeline(db: AsyncSession, workspace: Workspace):
    stage = {
        "role": "implementer",
        "unique": False,
        "discover": {
            "strategy": "column_scan",
            "column_type": "backlog",
            "filters": {},
        },
        "claim": {
            "participant_role": "helper",
            "execution_action": "implement_card",
            "pipeline_role": "implementer",
        },
        "git": {"action": "none", "create_pr": False},
        "llm": {"enabled": False, "stage": ""},
        "sensors": [],
        "on_success": {},
    }
    config = {
        "version": 1,
        "stages": [stage],
        "scheduling": {"mode": "priority", "priority_order": ["implementer"]},
    }
    db.add(WorkspaceConfig(workspace_id=workspace.id, pipeline_config=config))
    await db.flush()


async def _make_frozen_board(
    db: AsyncSession, workspace: Workspace, user: User
) -> Board:
    board = Board(
        workspace_id=workspace.id,
        name="Frozen Board",
        slug="frozen-board",
        created_by=user.id,
    )
    db.add(board)
    await db.flush()
    board.is_frozen = True
    board.frozen_at = datetime.now(timezone.utc)
    await db.flush()
    return board


# --- tests -------------------------------------------------------------------


async def test_next_assignment_skips_frozen_board_picks_unfrozen(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """The frozen board's card sorts FIRST (position asc) — without the freeze
    gate the scheduler would pick it, so this red proves the skip."""
    await _seed_implementer_pipeline(db_session, test_workspace)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    frozen_board = await _make_frozen_board(db_session, test_workspace, test_user)
    frozen_col = await _make_backlog_column(db_session, frozen_board)
    await _make_repo(db_session, frozen_board, test_user, "frozen-repo")
    await _make_card(
        db_session, frozen_board, frozen_col, test_user,
        title="tempting-but-frozen", position=1.0,
    )

    open_col = await _make_backlog_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user, "open-repo")
    open_card = await _make_card(
        db_session, test_board, open_col, test_user,
        title="open-card", position=4096.0,
    )

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["id"] == str(open_card.id)


async def test_next_assignment_only_frozen_board_returns_204_no_reservation(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    await _seed_implementer_pipeline(db_session, test_workspace)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    column = await _make_backlog_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user, "only-repo")
    await _make_card(
        db_session, test_board, column, test_user, title="iced", position=1.0
    )
    test_board.is_frozen = True
    test_board.frozen_at = datetime.now(timezone.utc)
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert resp.status_code == 204, resp.text

    reservation_count = await db_session.scalar(
        select(func.count()).select_from(AgentReservation)
    )
    assert reservation_count == 0


async def test_reservation_not_reissued_after_board_frozen(
    agent_client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
    db_session: AsyncSession,
):
    """SPLIT-BRAIN guard: the scheduler consults live reservations BEFORE the
    candidate scan, so the freeze check must be mirrored into
    _reservation_still_eligible or a frozen board keeps re-issuing its card."""
    await _seed_implementer_pipeline(db_session, test_workspace)
    await _add_team_role(
        db_session, test_workspace, test_agent, test_user, "implementer"
    )

    column = await _make_backlog_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user, "reissue-repo")
    card = await _make_card(
        db_session, test_board, column, test_user, title="held", position=1.0
    )
    # Reservation taken while the board was still open...
    db_session.add(AgentReservation(
        agent_id=test_agent.id,
        card_id=card.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        role="implementer",
        expires_at=datetime.utcnow() + timedelta(seconds=600),
    ))
    await db_session.flush()
    # ...then the board froze.
    test_board.is_frozen = True
    test_board.frozen_at = datetime.now(timezone.utc)
    await db_session.flush()

    resp = await agent_client.post(
        URL_TPL.format(slug=test_workspace.slug, agent_id=test_agent.id), json={}
    )
    assert resp.status_code == 204, resp.text
