# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Service-level tests for TeamService — role-agnostic defaults (Wave 2 Lane A).

The runner is the source of authority on which pipeline roles it claims, but
the backend declares the default: empty `roles` on a team member means the
agent claims every pipeline role. Non-empty `roles` narrows the agent to that
subset — useful for sharding but also a footgun (the Go runner now emits a
loud Warn when scoping drops pipeline stages).

See feedback_runner_role_agnostic.md and feedback_backend_authoritative_config.md.
"""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.agents.team import TeamCreate, TeamMemberAdd
from app.services.agents.agent import AgentService
from app.services.agents.team import TeamService


async def _make_agent(db: AsyncSession, owner: User, name: str) -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="",
        created_by_id=owner.id,
        is_active=True,
    )
    db.add(agent)
    await db.flush()
    return agent


@pytest.mark.asyncio
async def test_team_member_add_accepts_empty_roles_for_role_agnostic_default(
    db_session: AsyncSession,
):
    """Empty roles is the role-agnostic default — schema must accept it.

    A `roles_non_empty` validator on the schema would force every team
    membership into the scoped-narrow path, defeating the default and
    making the runner-side empty-team_roles branch unreachable from the UI.
    """
    payload = TeamMemberAdd.model_validate(
        {"agent_id": "00000000-0000-0000-0000-000000000001", "roles": []}
    )
    assert payload.roles == []


@pytest.mark.asyncio
async def test_add_member_with_empty_roles_persists_empty_list(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    """A member added with roles=[] must persist as the role-agnostic default."""
    service = TeamService(db_session)
    team, _ = await service.create_team(
        test_workspace.id,
        TeamCreate(name="Agnostic Team"),
        test_user.id,
    )
    agent = await _make_agent(db_session, test_user, "agnostic-bot")

    member = await service.add_member(
        team.id, TeamMemberAdd(agent_id=agent.id, roles=[])
    )

    assert member.roles == []


@pytest.mark.asyncio
async def test_agent_config_team_roles_empty_for_role_agnostic_member(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User,
):
    """The Go runner reads `team_roles` from /me/config and falls into the
    role-agnostic branch (= claim every pipeline role) when it's empty.
    Verify the projection holds end-to-end: empty member.roles -> empty
    team_roles on the agent config payload."""
    team_service = TeamService(db_session)
    team, _ = await team_service.create_team(
        test_workspace.id,
        TeamCreate(name="Wire Default Team"),
        test_user.id,
    )
    agent = await _make_agent(db_session, test_user, "wire-default-bot")
    await team_service.add_member(
        team.id, TeamMemberAdd(agent_id=agent.id, roles=[])
    )

    agent_service = AgentService(db_session)
    config = await agent_service.get_agent_config(agent.id)

    assert config["team_roles"] == []
    assert config["team_role"] is None
