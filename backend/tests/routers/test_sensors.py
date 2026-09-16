# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for the workspace sensor catalog endpoint.

The endpoint aggregates sensor manifests reported by agents via heartbeat.
This decouples the platform from knowing which sensors exist statically —
agents are the source of truth for what they support.
"""

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


def _sensors_url(workspace_slug: str) -> str:
    return f"/api/workspaces/{workspace_slug}/sensors"


def _make_agent(
    user_id,
    workspace_slug: str,
    sensor_catalog: list[dict] | None,
    name: str = "test-sensor-agent",
) -> Agent:
    return Agent(
        name=name,
        agent_type=AgentType.coding,
        description="",
        created_by_id=user_id,
        is_active=True,
        allowed_workspaces=[workspace_slug],
        sensor_catalog=sensor_catalog,
    )


async def test_list_sensors_empty_when_no_agents_reported(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(_sensors_url(test_workspace.slug))
    assert response.status_code == 200
    assert response.json() == []


async def test_list_sensors_returns_reported_catalog(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
):
    catalog = [
        {
            "name": "go-test",
            "kind": "computational",
            "default_config": {"packages": "./...", "timeout": "120s", "tags": ""},
            "description": "Runs Go tests.",
        }
    ]
    db_session.add(_make_agent(test_user.id, test_workspace.slug, catalog))
    await db_session.flush()

    response = await client.get(_sensors_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 1
    assert data[0]["name"] == "go-test"
    assert data[0]["kind"] == "computational"
    assert data[0]["default_config"]["packages"] == "./..."
    assert data[0]["description"] == "Runs Go tests."


async def test_list_sensors_deduplicates_by_name(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
):
    # Two agents in the same workspace report overlapping catalogs; the endpoint
    # returns each sensor name once.
    db_session.add(
        _make_agent(
            test_user.id,
            test_workspace.slug,
            [{"name": "go-test", "kind": "computational", "default_config": {}}],
            name="agent-a",
        )
    )
    db_session.add(
        _make_agent(
            test_user.id,
            test_workspace.slug,
            [
                {"name": "go-test", "kind": "computational", "default_config": {}},
                {"name": "eslint", "kind": "computational", "default_config": {}},
            ],
            name="agent-b",
        )
    )
    await db_session.flush()

    response = await client.get(_sensors_url(test_workspace.slug))
    assert response.status_code == 200
    data = response.json()
    names = sorted(entry["name"] for entry in data)
    assert names == ["eslint", "go-test"]


async def test_list_sensors_scoped_per_workspace(
    client: AsyncClient,
    test_workspace: Workspace,
    test_user: User,
    db_session: AsyncSession,
):
    # Agent reports a catalog only for workspace A; querying B returns empty.
    other_workspace = Workspace(name="Other", slug="other", created_by=test_user.id)
    db_session.add(other_workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=other_workspace.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    db_session.add(
        _make_agent(
            test_user.id,
            test_workspace.slug,
            [{"name": "go-test", "kind": "computational", "default_config": {}}],
        )
    )
    await db_session.flush()

    response_a = await client.get(_sensors_url(test_workspace.slug))
    assert [e["name"] for e in response_a.json()] == ["go-test"]

    response_b = await client.get(_sensors_url(other_workspace.slug))
    assert response_b.json() == []


async def test_list_sensors_unknown_workspace(client: AsyncClient):
    response = await client.get(_sensors_url("does-not-exist"))
    assert response.status_code == 404


async def test_list_sensors_rejects_non_member(
    client: AsyncClient,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    # second_user creates a workspace the test_user isn't a member of.
    foreign = Workspace(name="Foreign", slug="foreign", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(workspace_id=foreign.id, user_id=second_user.id, role=WorkspaceRole.owner)
    )
    await db_session.flush()

    response = await client.get(_sensors_url("foreign"))
    assert response.status_code == 403


async def test_list_sensors_enforces_membership_via_workspace_dependency(
    client: AsyncClient,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    # Confirms the route delegates auth to get_workspace: a workspace owned by
    # another user, with agents reporting sensors, still returns 403 rather than
    # leaking the catalog to a non-member.
    foreign = Workspace(name="Foreign Two", slug="foreign-two", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(workspace_id=foreign.id, user_id=second_user.id, role=WorkspaceRole.owner)
    )
    db_session.add(
        _make_agent(
            second_user.id,
            foreign.slug,
            [{"name": "go-test", "kind": "computational", "default_config": {}}],
            name="foreign-agent",
        )
    )
    await db_session.flush()

    response = await client.get(_sensors_url("foreign-two"))
    assert response.status_code == 403
