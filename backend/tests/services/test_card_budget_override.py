# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Cluster I — per-card budget override field.

A card may carry an optional `budget_usd_override` that the runner consults
to give an outsized card more runway than the workspace-global
`max_budget_usd` yaml ceiling — without editing the global config. The field
is groundwork for the budget-SUSPEND classifier (Go runner, next session);
this slice only adds the column, the CardRead surface, and the next-assignment
bundle plumbing so the value reaches the runner.

Nullable per the rolling-deploy migration-safety rule: NULL means "no
override, use the global ceiling".
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.kanban.card import Card, Priority
from app.models.kanban.column import Column, ColumnType
from app.models.user import User
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig


CARD_URL = "/api/workspaces/{slug}/boards/{board_id}/cards/{card_id}"
NEXT_URL = "/api/workspaces/{slug}/agents/{agent_id}/next-assignment"


async def _make_active_column(db: AsyncSession, board: Board) -> Column:
    col = Column(
        board_id=board.id, name="In Progress", position=2.0,
        color="#888", column_type=ColumnType.active,
    )
    db.add(col)
    await db.flush()
    return col


async def _make_repo(db: AsyncSession, board: Board, user: User) -> GitRepo:
    repo = GitRepo(
        board_id=board.id, workspace_id=board.workspace_id, name="acme",
        slug="acme", url="https://github.com/acme/acme",
        provider=GitProvider.github, default_branch="main", added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _add_team_role(
    db: AsyncSession, workspace: Workspace, agent: Agent, user: User, role: str
):
    team = AgentTeam(name=f"{role}-team", workspace_id=workspace.id, created_by_id=user.id)
    db.add(team)
    await db.flush()
    db.add(AgentTeamMember(team_id=team.id, agent_id=agent.id, roles=[role]))
    await db.flush()


def _implementer_stage() -> dict:
    return {
        "role": "implementer",
        "unique": False,
        "discover": {"strategy": "column_scan", "column_type": "active",
                     "filters": {"require_git_repo": True}},
        "claim": {"participant_role": "helper", "execution_action": "implement_card",
                  "pipeline_role": "implementer"},
        "git": {"action": "none", "create_pr": False},
        "llm": {"enabled": False, "stage": ""},
        "sensors": [],
        "on_success": {},
    }


async def _seed_pipeline(db: AsyncSession, workspace: Workspace):
    db.add(WorkspaceConfig(
        workspace_id=workspace.id,
        pipeline_config={
            "version": 1,
            "stages": [_implementer_stage()],
            "scheduling": {"mode": "priority", "priority_order": ["implementer"]},
        },
    ))
    await db.flush()


@pytest.mark.asyncio
async def test_card_budget_override_defaults_to_none(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    col = await _make_active_column(db_session, test_board)
    card = Card(
        board_id=test_board.id, column_id=col.id, title="ordinary",
        position=1024.0, priority=Priority.medium, created_by=test_user.id,
    )
    db_session.add(card)
    await db_session.flush()

    resp = await client.get(
        CARD_URL.format(slug=test_workspace.slug, board_id=test_board.id, card_id=card.id)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["budget_usd_override"] is None


@pytest.mark.asyncio
async def test_card_read_surfaces_budget_override(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    col = await _make_active_column(db_session, test_board)
    card = Card(
        board_id=test_board.id, column_id=col.id, title="outsized",
        position=1024.0, priority=Priority.medium, created_by=test_user.id,
        budget_usd_override=42.5,
    )
    db_session.add(card)
    await db_session.flush()

    resp = await client.get(
        CARD_URL.format(slug=test_workspace.slug, board_id=test_board.id, card_id=card.id)
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["budget_usd_override"] == 42.5


@pytest.mark.asyncio
async def test_next_assignment_bundle_carries_budget_override(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_agent: Agent,
):
    """The override reaches the runner through the next-assignment card bundle."""
    await _seed_pipeline(db_session, test_workspace)
    col = await _make_active_column(db_session, test_board)
    await _make_repo(db_session, test_board, test_user)
    await _add_team_role(db_session, test_workspace, test_agent, test_user, "implementer")
    card = Card(
        board_id=test_board.id, column_id=col.id, title="outsized work",
        position=1024.0, priority=Priority.medium, created_by=test_user.id,
        budget_usd_override=30.0,
    )
    db_session.add(card)
    await db_session.flush()

    resp = await agent_client.post(
        NEXT_URL.format(slug=test_workspace.slug, agent_id=test_agent.id),
        json={},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["card"]["budget_usd_override"] == 30.0
