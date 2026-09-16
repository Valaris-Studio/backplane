# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`GET /api/agents/me/config` must serve the config of the workspace the
runner actually operates on, not an arbitrary one of its team's workspaces.

`AgentService.get_agent_config` derives its workspace from
`TeamService.get_agent_team_info`, which selected the FIRST team membership row
with no ORDER BY. For an agent on teams in two workspaces the served
`workspace_config` and `prompt_configs` were whichever row the database
happened to return — and never necessarily the workspace the runner was
configured for.

Confirmed in production 2026-05-19: a runner configured for workspace
`internal-projects` silently received `acme`'s pipeline_config and
burn-looped until it was killed.

Intended rule:
  - `?workspace_slug=<slug>` -> that workspace's config, deterministically
  - slug outside a non-empty `allowed_workspaces` -> 403
  - unknown slug -> 404
  - slug omitted -> team-derived, exactly as before

These tests authenticate over the REAL API-key path (a genuine ApiKey row whose
sha256 hash matches `ApiKeyService.verify_key`) so that `allowed_workspaces`
enforcement runs through the same `current_agent_id` plumbing as production.
The helpers mirror `test_agent_workspace_scope.py`, whose module docstring
explains why conftest's `agent_client` is unsuitable here.
"""

import hashlib
import secrets

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.api_key import ApiKey
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.workspace_config import WorkspaceConfigService

CONFIG_URL = "/api/agents/me/config"


async def _make_workspace(
    db_session: AsyncSession, owner: User, *, name: str, slug: str
) -> Workspace:
    workspace = Workspace(name=name, slug=slug, created_by=owner.id)
    db_session.add(workspace)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=owner.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    return workspace


async def _make_agent_with_key(
    db_session: AsyncSession,
    owner: User,
    *,
    allowed_workspaces: list[str] | None,
    name: str = "multi-workspace-agent",
) -> tuple[Agent, str]:
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=owner.id,
        name=f"{name}-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db_session.add(api_key)
    await db_session.flush()

    agent = Agent(
        name=name,
        agent_type=AgentType.coding,
        description="Agent under config-scope test",
        created_by_id=owner.id,
        is_active=True,
        api_key_id=api_key.id,
        allowed_workspaces=allowed_workspaces,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent, raw


async def _add_to_team(
    db_session: AsyncSession,
    agent: Agent,
    workspace: Workspace,
    owner: User,
    *,
    roles: list[str],
) -> AgentTeam:
    team = AgentTeam(
        name=f"team-{workspace.slug}",
        slug=f"team-{workspace.slug}",
        workspace_id=workspace.id,
        created_by_id=owner.id,
        is_active=True,
    )
    db_session.add(team)
    await db_session.flush()
    db_session.add(
        AgentTeamMember(team_id=team.id, agent_id=agent.id, roles=roles)
    )
    await db_session.flush()
    return team


async def _set_rework_attempts(
    db_session: AsyncSession, workspace: Workspace, value: int
) -> None:
    """Give each workspace a config value distinctive enough to identify it."""
    await WorkspaceConfigService(db_session).update_config(
        workspace.id, WorkspaceConfigUpdate(max_rework_attempts=value)
    )


@pytest_asyncio.fixture
async def raw_key_client(db_session: AsyncSession) -> AsyncClient:
    """Client with NO auth override — exercises the real Bearer vlr_ path."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


def _auth(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


async def test_workspace_slug_selects_that_workspaces_config(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    """The requested workspace's config wins over the other team's workspace.

    Team B is inserted LAST, so an unordered `.first()` is free to return
    either row; only slug-scoped resolution makes the answer deterministic.
    """
    workspace_a = await _make_workspace(
        db_session, test_user, name="Config WS A", slug="config-ws-a"
    )
    workspace_b = await _make_workspace(
        db_session, test_user, name="Config WS B", slug="config-ws-b"
    )
    await _set_rework_attempts(db_session, workspace_a, 7)
    await _set_rework_attempts(db_session, workspace_b, 19)

    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug, workspace_b.slug]
    )
    await _add_to_team(db_session, agent, workspace_a, test_user, roles=["coder"])
    await _add_to_team(db_session, agent, workspace_b, test_user, roles=["coder"])

    resp = await raw_key_client.get(
        CONFIG_URL, params={"workspace_slug": workspace_a.slug}, headers=_auth(raw_key)
    )
    assert resp.status_code == 200, f"{resp.status_code}: {resp.text}"
    assert resp.json()["workspace_config"]["max_rework_attempts"] == 7, (
        "config came from the wrong workspace — workspace_slug was ignored"
    )

    resp_b = await raw_key_client.get(
        CONFIG_URL, params={"workspace_slug": workspace_b.slug}, headers=_auth(raw_key)
    )
    assert resp_b.status_code == 200, f"{resp_b.status_code}: {resp_b.text}"
    assert resp_b.json()["workspace_config"]["max_rework_attempts"] == 19, (
        "the same agent must get B's config when it asks for B"
    )


async def test_workspace_slug_outside_allowed_workspaces_is_denied(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    """An agent may not read the pipeline config of a workspace it is not
    scoped to, even though its creating user owns that workspace."""
    workspace_a = await _make_workspace(
        db_session, test_user, name="Denied WS A", slug="denied-ws-a"
    )
    workspace_b = await _make_workspace(
        db_session, test_user, name="Denied WS B", slug="denied-ws-b"
    )
    await _set_rework_attempts(db_session, workspace_b, 19)

    agent, raw_key = await _make_agent_with_key(
        db_session,
        test_user,
        allowed_workspaces=[workspace_a.slug],
        name="scoped-to-a-only",
    )
    await _add_to_team(db_session, agent, workspace_a, test_user, roles=["coder"])

    resp = await raw_key_client.get(
        CONFIG_URL, params={"workspace_slug": workspace_b.slug}, headers=_auth(raw_key)
    )
    assert resp.status_code == 403, (
        "agent scoped to A read workspace B's config: "
        f"{resp.status_code} {resp.text}"
    )


async def test_unknown_workspace_slug_is_not_found(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    workspace_a = await _make_workspace(
        db_session, test_user, name="Unknown WS A", slug="unknown-ws-a"
    )
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=None, name="unrestricted-agent"
    )
    await _add_to_team(db_session, agent, workspace_a, test_user, roles=["coder"])

    resp = await raw_key_client.get(
        CONFIG_URL,
        params={"workspace_slug": "no-such-workspace-anywhere"},
        headers=_auth(raw_key),
    )
    assert resp.status_code == 404, f"{resp.status_code}: {resp.text}"


async def test_omitted_workspace_slug_keeps_team_derived_behavior(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
):
    """The legacy no-slug path stays exactly as it was: config comes from the
    agent's team workspace, and team identity is still reported."""
    workspace_a = await _make_workspace(
        db_session, test_user, name="Legacy WS A", slug="legacy-ws-a"
    )
    await _set_rework_attempts(db_session, workspace_a, 7)

    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug], name="legacy-agent"
    )
    team = await _add_to_team(
        db_session, agent, workspace_a, test_user, roles=["coder"]
    )

    resp = await raw_key_client.get(CONFIG_URL, headers=_auth(raw_key))
    assert resp.status_code == 200, f"{resp.status_code}: {resp.text}"
    body = resp.json()
    assert body["workspace_config"]["max_rework_attempts"] == 7
    assert body["team_id"] == str(team.id)
    assert body["team_roles"] == ["coder"]
