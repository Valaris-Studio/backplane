# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP-level tests for the board runner-config download endpoint."""

from __future__ import annotations

import json

import yaml
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.git.git_repo import GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace


async def test_get_runner_config_prefilled_from_board(
    client: AsyncClient, test_workspace: Workspace, test_board: Board, test_git_repo: GitRepo
):
    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}/runner-config"
    )
    assert resp.status_code == 200
    body = resp.json()

    cfg = yaml.safe_load(body["runner_yaml"])
    assert cfg["valaris"]["workspace_slug"] == test_workspace.slug
    assert cfg["valaris"]["board_ids"] == [str(test_board.id)]
    assert cfg["git"]["forge"] == "github"  # test_git_repo is a github repo

    mcp = json.loads(body["mcp_config_json"])
    assert "vlr_" not in mcp["mcpServers"]["valaris"]["env"]["VALARIS_API_KEY"]
    assert isinstance(body["prerequisites"], list) and body["prerequisites"]
    assert len(body["prerequisite_messages"]) == len(body["prerequisites"])
    assert body["prerequisite_messages"][0] == {
        "code": "agent_key_create",
        "params": {},
    }
    assert body["prerequisite_messages"][1] == {
        "code": "team_binding",
        "params": {"workspace_slug": test_workspace.slug},
    }
    assert "vlr_" not in json.dumps(body["prerequisite_messages"]).lower()


async def test_get_runner_config_for_agent_omits_create_and_bind_prereqs(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    test_user: User,
):
    test_agent.allowed_workspaces = [test_workspace.slug]
    team = AgentTeam(
        name="Runner team",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        AgentTeamMember(
            team_id=team.id,
            agent_id=test_agent.id,
            roles=["implementer"],
        )
    )
    await db_session.flush()

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={test_agent.id}"
    )
    assert resp.status_code == 200
    prereqs = " ".join(resp.json()["prerequisites"]).lower()
    assert "create an agent" not in prereqs
    assert "team binding" not in prereqs
    assert test_agent.name.lower() in prereqs
    messages = resp.json()["prerequisite_messages"]
    assert len(messages) == len(resp.json()["prerequisites"])
    assert messages[0] == {
        "code": "agent_key_export_or_rotate",
        "params": {"agent_name": test_agent.name},
    }
    assert not any(message["code"] == "team_binding" for message in messages)


async def test_get_runner_config_for_existing_unbound_agent_keeps_binding_prereq(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
):
    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={test_agent.id}"
    )

    assert resp.status_code == 200
    body = resp.json()
    prereqs = " ".join(body["prerequisites"]).lower()
    assert "create an agent" not in prereqs
    assert "team binding" in prereqs
    assert body["prerequisite_messages"][:2] == [
        {
            "code": "agent_key_export_or_rotate",
            "params": {"agent_name": test_agent.name},
        },
        {
            "code": "team_binding",
            "params": {"workspace_slug": test_workspace.slug},
        },
    ]
    assert len(body["prerequisite_messages"]) == len(body["prerequisites"])


async def test_get_runner_config_accepts_legacy_unrestricted_agent_with_one_team(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    test_user: User,
):
    assert not test_agent.allowed_workspaces
    team = AgentTeam(
        name="Legacy runner team",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        AgentTeamMember(
            team_id=team.id,
            agent_id=test_agent.id,
            roles=["implementer"],
        )
    )
    await db_session.flush()

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={test_agent.id}"
    )

    assert resp.status_code == 200
    messages = resp.json()["prerequisite_messages"]
    assert messages[0]["code"] == "agent_key_export_or_rotate"
    assert not any(message["code"] == "team_binding" for message in messages)


async def test_get_runner_config_keeps_binding_when_agent_scope_excludes_workspace(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    test_user: User,
):
    test_agent.allowed_workspaces = ["different-workspace"]
    team = AgentTeam(
        name="Scoped elsewhere runner team",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        AgentTeamMember(
            team_id=team.id,
            agent_id=test_agent.id,
            roles=["implementer"],
        )
    )
    await db_session.flush()

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={test_agent.id}"
    )

    assert resp.status_code == 200
    assert any(
        message["code"] == "team_binding"
        for message in resp.json()["prerequisite_messages"]
    )


async def test_get_runner_config_keeps_binding_for_team_in_another_workspace(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    test_user: User,
):
    test_agent.allowed_workspaces = [test_workspace.slug]
    other_workspace = Workspace(
        name="Other workspace",
        slug="runner-config-other-workspace",
        created_by=test_user.id,
    )
    db_session.add(other_workspace)
    await db_session.flush()
    team = AgentTeam(
        name="Other workspace runner team",
        workspace_id=other_workspace.id,
        created_by_id=test_user.id,
        is_active=True,
    )
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        AgentTeamMember(
            team_id=team.id,
            agent_id=test_agent.id,
            roles=["implementer"],
        )
    )
    await db_session.flush()

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={test_agent.id}"
    )

    assert resp.status_code == 200
    assert any(
        message["code"] == "team_binding"
        for message in resp.json()["prerequisite_messages"]
    )


async def test_get_runner_config_keeps_binding_when_agent_has_multiple_active_teams(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_agent: Agent,
    test_user: User,
):
    test_agent.allowed_workspaces = [test_workspace.slug]
    teams = [
        AgentTeam(
            name=f"Runner team {index}",
            workspace_id=test_workspace.id,
            created_by_id=test_user.id,
            is_active=True,
        )
        for index in range(2)
    ]
    db_session.add_all(teams)
    await db_session.flush()
    db_session.add_all(
        [
            AgentTeamMember(
                team_id=team.id,
                agent_id=test_agent.id,
                roles=["implementer"],
            )
            for team in teams
        ]
    )
    await db_session.flush()

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={test_agent.id}"
    )

    assert resp.status_code == 200
    assert any(
        message["code"] == "team_binding"
        for message in resp.json()["prerequisite_messages"]
    )


async def test_get_runner_config_unknown_agent_id_404(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    import uuid as _uuid

    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={_uuid.uuid4()}"
    )
    assert resp.status_code == 404


async def test_get_runner_config_foreign_agent_matches_unknown_without_name_leak(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    second_user: User,
):
    import uuid as _uuid

    foreign_agent = Agent(
        name="do-not-disclose-this-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
        allowed_workspaces=[test_workspace.slug],
        is_active=True,
    )
    db_session.add(foreign_agent)
    await db_session.flush()

    foreign = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={foreign_agent.id}"
    )
    unknown = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.id}"
        f"/runner-config?agent_id={_uuid.uuid4()}"
    )

    assert foreign.status_code == unknown.status_code == 404
    assert foreign.json() == unknown.json()
    assert foreign_agent.name not in foreign.text


async def test_get_runner_config_accepts_board_slug(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{test_board.slug}/runner-config"
    )
    assert resp.status_code == 200


async def test_get_runner_config_unknown_board_404(
    client: AsyncClient, test_workspace: Workspace
):
    resp = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/does-not-exist/runner-config"
    )
    assert resp.status_code == 404
