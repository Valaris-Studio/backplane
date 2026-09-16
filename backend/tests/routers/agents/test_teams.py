# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from datetime import datetime, timedelta

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace


async def _create_agent(db_session: AsyncSession, user: User, name: str = "bot-1") -> Agent:
    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description=f"Agent {name}",
        created_by_id=user.id,
        is_active=True,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent


def _teams_url(slug: str) -> str:
    return f"/api/workspaces/{slug}/teams"


async def test_list_teams_empty(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.get(_teams_url(test_workspace.slug))
    assert response.status_code == 200
    assert response.json() == []


async def test_create_team_success(
    client: AsyncClient, test_workspace: Workspace, test_user: User,
):
    payload = {"name": "Alpha Team", "description": "First team"}
    response = await client.post(_teams_url(test_workspace.slug), json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Alpha Team"
    assert data["description"] == "First team"
    assert data["workspace_id"] == str(test_workspace.id)
    assert data["created_by_id"] == str(test_user.id)
    assert data["is_active"] is True
    assert data["members"] == []


async def test_get_team_success(
    client: AsyncClient, test_workspace: Workspace,
):
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Beta Team"}
    )
    team_id = create_resp.json()["id"]

    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    assert response.status_code == 200
    assert response.json()["id"] == team_id
    assert response.json()["name"] == "Beta Team"


async def test_get_team_not_found(
    client: AsyncClient, test_workspace: Workspace,
):
    fake_id = uuid.uuid4()
    response = await client.get(f"{_teams_url(test_workspace.slug)}/{fake_id}")
    assert response.status_code == 404


async def test_update_team_success(
    client: AsyncClient, test_workspace: Workspace,
):
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Old Name"}
    )
    team_id = create_resp.json()["id"]

    response = await client.patch(
        f"{_teams_url(test_workspace.slug)}/{team_id}",
        json={"name": "New Name", "description": "Updated"},
    )
    assert response.status_code == 200
    assert response.json()["name"] == "New Name"
    assert response.json()["description"] == "Updated"


async def test_deactivate_team(
    client: AsyncClient, test_workspace: Workspace,
):
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Temp Team"}
    )
    team_id = create_resp.json()["id"]

    response = await client.delete(f"{_teams_url(test_workspace.slug)}/{team_id}")
    assert response.status_code == 200
    assert response.json()["is_active"] is False


async def test_add_member_with_roles_array(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "multi-role-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Multi Role Team"}
    )
    team_id = create_resp.json()["id"]

    response = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["orchestrator", "reviewer"]},
    )
    assert response.status_code == 201
    members = response.json()["members"]
    assert len(members) == 1
    assert members[0]["agent_id"] == str(agent.id)
    assert set(members[0]["roles"]) == {"orchestrator", "reviewer"}
    assert members[0]["agent_name"] == "multi-role-bot"


async def test_add_member_single_role_compat(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "single-role-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Single Role Team"}
    )
    team_id = create_resp.json()["id"]

    response = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["orchestrator"]},
    )
    assert response.status_code == 201
    members = response.json()["members"]
    assert len(members) == 1
    assert members[0]["roles"] == ["orchestrator"]


async def test_add_member_duplicate_role_conflict(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Two different agents cannot hold the same unique role in one team."""
    agent1 = await _create_agent(db_session, test_user, "bot-a")
    agent2 = await _create_agent(db_session, test_user, "bot-b")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Role Conflict"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent1.id), "roles": ["implementer"]},
    )
    response = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent2.id), "roles": ["implementer"]},
    )
    assert response.status_code == 422


async def test_add_member_same_agent_update_roles(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Adding an existing agent again with new roles should idempotently update."""
    agent = await _create_agent(db_session, test_user, "update-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Idempotent Team"}
    )
    team_id = create_resp.json()["id"]

    # First add with orchestrator
    r1 = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["orchestrator"]},
    )
    assert r1.status_code == 201

    # Same agent, new roles — should update, not 409
    r2 = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["orchestrator", "reviewer"]},
    )
    assert r2.status_code == 201
    members = r2.json()["members"]
    assert len(members) == 1
    assert set(members[0]["roles"]) == {"orchestrator", "reviewer"}


async def test_get_team_members_returns_roles_array(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "roles-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Roles Array Team"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["reviewer", "documentator"]},
    )

    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    assert response.status_code == 200
    members = response.json()["members"]
    assert len(members) == 1
    assert set(members[0]["roles"]) == {"reviewer", "documentator"}


async def test_add_member_custom_role_allows_duplicates(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent1 = await _create_agent(db_session, test_user, "custom-a")
    agent2 = await _create_agent(db_session, test_user, "custom-b")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Custom Roles"}
    )
    team_id = create_resp.json()["id"]

    r1 = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent1.id), "roles": ["custom"]},
    )
    assert r1.status_code == 201
    r2 = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent2.id), "roles": ["custom"]},
    )
    assert r2.status_code == 201
    assert len(r2.json()["members"]) == 2


async def test_remove_member_success(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "remove-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Remove Test"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["custom"]},
    )
    response = await client.delete(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members/{agent.id}"
    )
    assert response.status_code == 200
    assert len(response.json()["members"]) == 0


async def test_team_read_includes_slug(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Slug Me"}
    )
    assert response.status_code == 201
    assert response.json()["slug"] == "slug-me"


async def test_create_team_auto_generates_slug(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Platform Ops"}
    )
    assert response.json()["slug"] == "platform-ops"


async def test_create_team_disambiguates_duplicate_slug(
    client: AsyncClient, test_workspace: Workspace,
):
    r1 = await client.post(_teams_url(test_workspace.slug), json={"name": "Platform"})
    r2 = await client.post(_teams_url(test_workspace.slug), json={"name": "Platform"})
    assert r1.json()["slug"] == "platform"
    assert r2.json()["slug"] == "platform-2"


async def test_create_team_accepts_user_slug(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.post(
        _teams_url(test_workspace.slug),
        json={"name": "Custom Name", "slug": "my-custom-slug"},
    )
    assert response.status_code == 201
    assert response.json()["slug"] == "my-custom-slug"


async def test_create_team_rejects_invalid_slug(
    client: AsyncClient, test_workspace: Workspace,
):
    response = await client.post(
        _teams_url(test_workspace.slug),
        json={"name": "Bad", "slug": "Invalid Slug!"},
    )
    assert response.status_code == 422


async def test_create_team_duplicate_user_slug_returns_existing(
    client: AsyncClient, test_workspace: Workspace,
):
    first = await client.post(
        _teams_url(test_workspace.slug),
        json={"name": "Original", "slug": "shared"},
    )
    assert first.status_code == 201
    original_id = first.json()["id"]

    second = await client.post(
        _teams_url(test_workspace.slug),
        json={"name": "Different Name", "slug": "shared"},
    )
    assert second.status_code == 200
    assert second.json()["id"] == original_id
    assert second.json()["name"] == "Original"


async def test_get_team_by_slug(
    client: AsyncClient, test_workspace: Workspace,
):
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Findable"}
    )
    slug = create_resp.json()["slug"]

    response = await client.get(f"{_teams_url(test_workspace.slug)}/{slug}")
    assert response.status_code == 200
    assert response.json()["slug"] == slug


async def test_get_team_by_uuid_still_works(
    client: AsyncClient, test_workspace: Workspace,
):
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "UUID Lookup"}
    )
    team_id = create_resp.json()["id"]

    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    assert response.status_code == 200
    assert response.json()["id"] == team_id


async def test_get_team_by_slug_scoped_to_workspace(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    other = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other)
    await db_session.flush()
    from app.models.workspace import WorkspaceMember, WorkspaceRole
    db_session.add(
        WorkspaceMember(workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner)
    )
    await db_session.flush()

    await client.post(_teams_url(other.slug), json={"name": "Sibling"})

    response = await client.get(f"{_teams_url(test_workspace.slug)}/sibling")
    assert response.status_code == 404


async def test_update_team_slug_conflict_returns_409(
    client: AsyncClient, test_workspace: Workspace,
):
    r1 = await client.post(_teams_url(test_workspace.slug), json={"name": "Alpha"})
    r2 = await client.post(_teams_url(test_workspace.slug), json={"name": "Beta"})
    team2_id = r2.json()["id"]
    alpha_slug = r1.json()["slug"]

    response = await client.patch(
        f"{_teams_url(test_workspace.slug)}/{team2_id}",
        json={"slug": alpha_slug},
    )
    assert response.status_code == 409


async def test_agent_me_with_team_memberships(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
):
    from app.models.agents.team import AgentTeam, AgentTeamMember

    team = AgentTeam(
        name="Agent Team",
        description="For me endpoint test",
        workspace_id=test_workspace.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator", "reviewer"],
    )
    db_session.add(member)
    await db_session.flush()

    response = await agent_client.get("/api/agents/me")
    assert response.status_code == 200
    data = response.json()
    # New plural field
    assert data["team_memberships"] is not None
    assert len(data["team_memberships"]) == 1
    membership = data["team_memberships"][0]
    assert membership["team_id"] == str(team.id)
    assert membership["team_name"] == "Agent Team"
    assert set(membership["roles"]) == {"orchestrator", "reviewer"}
    # Backward-compat singular field (first role)
    assert data["team_membership"] is not None
    assert data["team_membership"]["role"] == "orchestrator"


async def test_agent_config_returns_team_roles(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
    test_board,
):
    from app.models.agents.team import AgentTeam, AgentTeamMember

    team = AgentTeam(
        name="Config Team",
        description="For config test",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator", "reviewer"],
    )
    db_session.add(member)
    await db_session.flush()

    response = await agent_client.get("/api/agents/me/config")
    assert response.status_code == 200
    data = response.json()

    # New plural field
    assert set(data["team_roles"]) == {"orchestrator", "reviewer"}
    # Backward-compat singular field
    assert data["team_role"] == "orchestrator"


async def test_export_team_success(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
    test_board,
):
    from app.models.agents.team import AgentTeam, AgentTeamMember

    agent_active = await _create_agent(db_session, test_user, name="hero")
    agent_inactive = await _create_agent(db_session, test_user, name="ghost")
    agent_inactive.is_active = False
    await db_session.flush()

    team = AgentTeam(
        name="Export Team",
        slug="export-team",
        description="Team for export test",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    db_session.add_all(
        [
            AgentTeamMember(
                team_id=team.id, agent_id=agent_active.id, roles=["orchestrator"]
            ),
            AgentTeamMember(
                team_id=team.id, agent_id=agent_inactive.id, roles=["reviewer"]
            ),
        ]
    )
    await db_session.flush()

    response = await client.get(
        f"/api/workspaces/{test_workspace.slug}/teams/export-team/export"
    )
    assert response.status_code == 200, response.text

    body = response.json()
    assert body["entity_type"] == "team"
    assert body["source_workspace_slug"] == test_workspace.slug

    data = body["data"]
    assert data["slug"] == "export-team"
    assert data["name"] == "Export Team"
    assert data["description"] == "Team for export test"
    assert data["is_active"] is True
    assert data["board_slug"] == test_board.slug

    by_name = {m["agent_name"]: m for m in data["members"]}
    assert by_name["hero"]["agent_slug"] == "hero"
    assert by_name["hero"]["roles"] == ["orchestrator"]
    assert by_name["hero"]["is_active"] is True
    assert by_name["ghost"]["is_active"] is False
    assert by_name["ghost"]["roles"] == ["reviewer"]

    assert (
        'filename="export-team.valaris.team.json"'
        in response.headers["content-disposition"]
    )


async def test_export_team_unknown_slug_returns_404(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(
        f"/api/workspaces/{test_workspace.slug}/teams/no-such-team/export"
    )
    assert response.status_code == 404


async def test_export_team_nonmember_workspace_returns_404(client: AsyncClient):
    response = await client.get("/api/workspaces/nonexistent/teams/whatever/export")
    assert response.status_code == 404


async def test_add_member_arbitrary_role_string_succeeds(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Operators add agents before their pipeline_config lists those roles.
    The service must accept any non-empty string; dangling roles surface
    later as role_warnings, not 422s. See feedback_extensibility_no_limits."""
    agent = await _create_agent(db_session, test_user, "auditor-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Extensible"}
    )
    team_id = create_resp.json()["id"]

    response = await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["security-auditor", "db-migrator"]},
    )
    assert response.status_code == 201
    members = response.json()["members"]
    assert set(members[0]["roles"]) == {"security-auditor", "db-migrator"}


async def test_member_has_no_role_warnings_when_all_roles_in_pipeline(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "legacy-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Warn Noop"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["implementer", "reviewer"]},
    )
    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    member = response.json()["members"][0]
    assert member["role_warnings"] == []


async def test_member_role_warnings_flag_dangling_roles(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "mixed-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Mixed Roles"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={
            "agent_id": str(agent.id),
            "roles": ["implementer", "reviewer", "security-auditor"],
        },
    )
    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    member = response.json()["members"][0]
    warnings = member["role_warnings"]
    assert len(warnings) == 1
    assert warnings[0] == {"role": "security-auditor", "reason": "not_in_pipeline"}


async def test_member_role_warnings_only_dangling_role(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    agent = await _create_agent(db_session, test_user, "dangling-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Dangling"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["custom"]},
    )
    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    member = response.json()["members"][0]
    assert member["role_warnings"] == [
        {"role": "custom", "reason": "not_in_pipeline"},
    ]


async def test_member_role_warnings_empty_pipeline_config_warns_every_role(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    from app.models.workspace_config import WorkspaceConfig

    config = WorkspaceConfig(
        workspace_id=test_workspace.id,
        pipeline_config={"version": 1, "stages": []},
    )
    db_session.add(config)
    await db_session.flush()

    agent = await _create_agent(db_session, test_user, "all-warn-bot")
    create_resp = await client.post(
        _teams_url(test_workspace.slug), json={"name": "Empty Pipeline"}
    )
    team_id = create_resp.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{team_id}/members",
        json={"agent_id": str(agent.id), "roles": ["orchestrator", "reviewer"]},
    )
    response = await client.get(f"{_teams_url(test_workspace.slug)}/{team_id}")
    member = response.json()["members"][0]
    by_role = {w["role"]: w for w in member["role_warnings"]}
    assert set(by_role.keys()) == {"orchestrator", "reviewer"}
    assert all(w["reason"] == "not_in_pipeline" for w in member["role_warnings"])


async def test_list_teams_populates_role_warnings_across_members(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """List endpoint enriches every member across every team; one
    pipeline_config fetch per request, not per member."""
    agent_ok = await _create_agent(db_session, test_user, "legacy-ok")
    agent_dangling = await _create_agent(db_session, test_user, "dangling")

    t1 = await client.post(_teams_url(test_workspace.slug), json={"name": "T1"})
    t2 = await client.post(_teams_url(test_workspace.slug), json={"name": "T2"})
    t1_id, t2_id = t1.json()["id"], t2.json()["id"]

    await client.post(
        f"{_teams_url(test_workspace.slug)}/{t1_id}/members",
        json={"agent_id": str(agent_ok.id), "roles": ["implementer"]},
    )
    await client.post(
        f"{_teams_url(test_workspace.slug)}/{t2_id}/members",
        json={"agent_id": str(agent_dangling.id), "roles": ["security-auditor"]},
    )

    response = await client.get(_teams_url(test_workspace.slug))
    teams_by_id = {t["id"]: t for t in response.json()}
    assert teams_by_id[t1_id]["members"][0]["role_warnings"] == []
    assert teams_by_id[t2_id]["members"][0]["role_warnings"] == [
        {"role": "security-auditor", "reason": "not_in_pipeline"}
    ]


async def test_team_role_enum_is_removed():
    """Backward-compat hatch for the dropped enum closed in T1.1. If this
    import ever succeeds again, some caller reintroduced a closed set of
    roles and violated feedback_extensibility_no_limits."""
    import pytest

    with pytest.raises(ImportError):
        from app.models.agents.team import TeamRole  # noqa: F401


# A fixed instant every membership shares unless a test asks otherwise, so the
# team_id tiebreaker — not the clock — decides order.
MEMBERSHIP_EPOCH = datetime(2026, 1, 1, 12, 0, 0)


async def _add_to_team(
    db_session: AsyncSession,
    agent: Agent,
    user: User,
    workspace: Workspace,
    team_name: str,
    roles: list[str],
    added_at: datetime = MEMBERSHIP_EPOCH,
):
    """Insert a membership with an EXPLICIT added_at.

    The server_default is CURRENT_TIMESTAMP, which has second resolution under
    SQLite: consecutive inserts usually tie but straddle a second boundary on a
    slow machine, silently promoting insertion order over the intended sort key
    and failing ordering assertions at random (a Cloud Build deploy gate flaked
    this way on 2026-08-13). Every membership here pins its own timestamp.
    """
    from app.models.agents.team import AgentTeam, AgentTeamMember

    team = AgentTeam(
        name=team_name,
        description=f"{team_name} for membership listing",
        workspace_id=workspace.id,
        created_by_id=user.id,
    )
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        AgentTeamMember(
            team_id=team.id, agent_id=agent.id, roles=roles, added_at=added_at
        )
    )
    await db_session.flush()
    return team


async def _second_workspace(db_session: AsyncSession, test_user: User) -> Workspace:
    from app.models.workspace import WorkspaceMember, WorkspaceRole

    workspace = Workspace(
        name="Second Workspace",
        slug=f"second-ws-{uuid.uuid4().hex[:8]}",
        created_by=test_user.id,
    )
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    return workspace


async def test_get_agent_returns_all_team_memberships(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
):
    """An agent on teams in two workspaces must show BOTH from GET /api/agents/{id}.

    Showing one (or, as shipped, none) made a two-team agent look team-less and
    misled incident debugging on 2026-05-19.
    """
    other_workspace = await _second_workspace(db_session, test_user)
    team_a = await _add_to_team(
        db_session, test_agent, test_user, test_workspace, "Team A", ["orchestrator"]
    )
    team_b = await _add_to_team(
        db_session, test_agent, test_user, other_workspace, "Team B", ["reviewer"]
    )

    response = await client.get(f"/api/agents/{test_agent.id}")
    assert response.status_code == 200
    memberships = response.json()["team_memberships"]
    assert len(memberships) == 2
    assert {m["team_id"] for m in memberships} == {str(team_a.id), str(team_b.id)}


async def test_agent_me_returns_all_team_memberships(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
):
    other_workspace = await _second_workspace(db_session, test_user)
    team_a = await _add_to_team(
        db_session, test_agent, test_user, test_workspace, "Team A", ["orchestrator"]
    )
    team_b = await _add_to_team(
        db_session, test_agent, test_user, other_workspace, "Team B", ["reviewer"]
    )

    response = await agent_client.get("/api/agents/me")
    assert response.status_code == 200
    data = response.json()
    assert {m["team_id"] for m in data["team_memberships"]} == {
        str(team_a.id),
        str(team_b.id),
    }
    # The singular compat field still names exactly one team — the same one
    # get_agent_team_info picks, so legacy consumers see no change.
    assert data["team_membership"]["team_id"] in {str(team_a.id), str(team_b.id)}


async def test_get_agent_memberships_exclude_inactive_teams(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
):
    active = await _add_to_team(
        db_session, test_agent, test_user, test_workspace, "Active Team", ["reviewer"]
    )
    retired = await _add_to_team(
        db_session, test_agent, test_user, test_workspace, "Retired Team", ["reviewer"]
    )
    retired.is_active = False
    await db_session.flush()

    response = await client.get(f"/api/agents/{test_agent.id}")
    assert response.status_code == 200
    memberships = response.json()["team_memberships"]
    assert [m["team_id"] for m in memberships] == [str(active.id)]


async def test_get_agent_memberships_are_deterministically_ordered(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
):
    """With added_at tied, team_id descending breaks the tie.

    Without the tiebreaker the order is whatever the DB returns and the response
    is not reproducible across calls. All three rows pin the same timestamp, so
    this asserts the tiebreaker alone — never the clock.
    """
    teams = [
        await _add_to_team(
            db_session, test_agent, test_user, test_workspace, f"Team {n}", ["reviewer"]
        )
        for n in range(3)
    ]

    first = await client.get(f"/api/agents/{test_agent.id}")
    second = await client.get(f"/api/agents/{test_agent.id}")
    order = [m["team_id"] for m in first.json()["team_memberships"]]
    assert order == [m["team_id"] for m in second.json()["team_memberships"]]
    assert set(order) == {str(t.id) for t in teams}
    assert order == sorted(order, reverse=True)


async def test_get_agent_memberships_order_newest_first_when_added_at_differs(
    client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
    test_user: User,
):
    """added_at is the PRIMARY sort key: newest membership first, regardless of team_id.

    The companion test pins equal timestamps to isolate the tiebreaker; this one
    spreads them to prove the tiebreaker never overrides recency.
    """
    teams = [
        await _add_to_team(
            db_session,
            test_agent,
            test_user,
            test_workspace,
            f"Team {n}",
            ["reviewer"],
            added_at=MEMBERSHIP_EPOCH + timedelta(minutes=n),
        )
        for n in range(3)
    ]

    response = await client.get(f"/api/agents/{test_agent.id}")
    assert response.status_code == 200
    order = [m["team_id"] for m in response.json()["team_memberships"]]
    assert order == [str(t.id) for t in reversed(teams)]
