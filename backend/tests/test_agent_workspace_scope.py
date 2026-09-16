# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Agent API-key scoping: `Agent.allowed_workspaces` must gate workspace routes.

`Agent.allowed_workspaces` is advertised as a scope restriction on agent API
keys, but `WorkspaceDep.__call__` only verifies the *user's* membership. Since
an agent's key resolves to its creating user — a member of both workspaces —
an agent scoped to workspace A can currently operate in workspace B.

Confirmed in production 2026-04-24: an agent with allowed_workspaces=["acme"]
made successful update_column calls against workspace "internal-projects".

Intended rule:
  - agent caller + non-empty allowed_workspaces + slug not in it -> 403
  - allowed_workspaces is None (legacy agents) -> unrestricted
  - human callers (X-User-Email) -> completely unaffected

These tests authenticate over the REAL API-key path: a genuine ApiKey row whose
sha256 hash matches `ApiKeyService.verify_key`, linked to an Agent via
`Agent.api_key_id`, sent as `Authorization: Bearer vlr_...`. The app under test
deliberately does NOT override `get_current_user`, so `app.core.auth` resolves
the agent and sets the `current_agent_id` ContextVar exactly as in production.
Using conftest's `agent_client` (which sets the ContextVar via a
`get_current_user` override) would bypass the very plumbing under test.
"""

import hashlib
import secrets
import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


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
    name: str = "scoped-agent",
) -> str:
    """Mint a real ApiKey + linked Agent; return the raw `vlr_` token.

    The hash must be sha256(raw) to match ApiKeyService.verify_key, and the
    Agent must be is_active=True or auth silently skips the agent lookup.
    """
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
        description="Agent under workspace-scope test",
        created_by_id=owner.id,
        is_active=True,
        api_key_id=api_key.id,
        allowed_workspaces=allowed_workspaces,
    )
    db_session.add(agent)
    await db_session.flush()
    return raw


@pytest_asyncio.fixture
async def raw_key_client(db_session: AsyncSession) -> AsyncClient:
    """Client with NO auth override — exercises the real Bearer vlr_ code path."""
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def workspace_a(db_session: AsyncSession, test_user: User) -> Workspace:
    return await _make_workspace(
        db_session, test_user, name="Workspace A", slug="workspace-a"
    )


@pytest_asyncio.fixture
async def workspace_b(db_session: AsyncSession, test_user: User) -> Workspace:
    """A second workspace owned by the SAME user, so membership is never the
    reason a request is denied — only agent scoping can be."""
    return await _make_workspace(
        db_session, test_user, name="Workspace B", slug="workspace-b"
    )


def _auth(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


async def test_agent_scoped_to_other_workspace_is_denied_write(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """An agent scoped to A must not WRITE into B, even though its creating
    user owns B."""
    raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    # Guard: prove the creating user really can write to B, so a 403 below
    # cannot be an ordinary membership failure.
    human_resp = await raw_key_client.post(
        f"/api/workspaces/{workspace_b.slug}/boards",
        json={"name": "Human Board In B"},
        headers={"X-User-Email": test_user.email},
    )
    assert human_resp.status_code == 201, (
        "precondition failed: the agent's creating user must be able to write "
        f"to workspace B, got {human_resp.status_code}: {human_resp.text}"
    )

    resp = await raw_key_client.post(
        f"/api/workspaces/{workspace_b.slug}/boards",
        json={"name": "Agent Board In B"},
        headers=_auth(raw_key),
    )
    assert resp.status_code == 403, (
        "agent scoped to workspace A wrote into workspace B: "
        f"{resp.status_code} {resp.text}"
    )


async def test_agent_scoped_to_other_workspace_is_denied_read(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """Reads are scoped too — a scope that still leaks another workspace's
    boards is not a scope."""
    raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    human_resp = await raw_key_client.get(
        f"/api/workspaces/{workspace_b.slug}/boards",
        headers={"X-User-Email": test_user.email},
    )
    assert human_resp.status_code == 200, (
        "precondition failed: the agent's creating user must be able to read "
        f"workspace B, got {human_resp.status_code}: {human_resp.text}"
    )

    resp = await raw_key_client.get(
        f"/api/workspaces/{workspace_b.slug}/boards",
        headers=_auth(raw_key),
    )
    assert resp.status_code == 403, (
        "agent scoped to workspace A read workspace B: "
        f"{resp.status_code} {resp.text}"
    )


async def test_agent_scoped_to_its_own_workspace_is_allowed(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """NEGATIVE CONTROL: the guard must not deny the agent's own workspace.
    Without this, a fix that denies everything would pass the tests above."""
    raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    read_resp = await raw_key_client.get(
        f"/api/workspaces/{workspace_a.slug}/boards",
        headers=_auth(raw_key),
    )
    assert read_resp.status_code == 200, read_resp.text

    write_resp = await raw_key_client.post(
        f"/api/workspaces/{workspace_a.slug}/boards",
        json={"name": "Agent Board In A"},
        headers=_auth(raw_key),
    )
    assert write_resp.status_code == 201, write_resp.text


async def test_deactivating_an_agent_does_not_widen_its_scope(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """Deactivation must not turn a scoped key into an unscoped one.

    Auth only bound the agent identity for `is_active` agents, so flipping the
    flag left the key authenticating as its creating *user* — and the scope
    guard, seeing no agent, waved it through to every workspace that user
    belongs to. The operator action that reads as "revoke" widened access.
    """
    raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    denied = await raw_key_client.get(
        f"/api/workspaces/{workspace_b.slug}/boards", headers=_auth(raw_key)
    )
    assert denied.status_code == 403, (
        f"precondition failed: the active agent should be denied workspace B, got {denied.text}"
    )

    agent = (
        await db_session.execute(
            select(Agent).where(Agent.allowed_workspaces == [workspace_a.slug])
        )
    ).scalar_one()
    agent.is_active = False
    await db_session.flush()

    after = await raw_key_client.get(
        f"/api/workspaces/{workspace_b.slug}/boards", headers=_auth(raw_key)
    )
    assert after.status_code != 200, (
        "deactivating the agent widened its access: the key reached workspace B, "
        f"which it was denied while active (got {after.status_code})"
    )


async def test_agent_with_null_allowed_workspaces_is_unrestricted(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """NEGATIVE CONTROL / migration safety: legacy agents have
    allowed_workspaces=None and must keep working everywhere. A fix that
    treats None as "deny all" would break every existing agent."""
    raw_key = await _make_agent_with_key(
        db_session,
        test_user,
        allowed_workspaces=None,
        name="legacy-unscoped-agent",
    )

    for workspace in (workspace_a, workspace_b):
        read_resp = await raw_key_client.get(
            f"/api/workspaces/{workspace.slug}/boards",
            headers=_auth(raw_key),
        )
        assert read_resp.status_code == 200, (
            f"legacy agent denied read on {workspace.slug}: {read_resp.text}"
        )

        write_resp = await raw_key_client.post(
            f"/api/workspaces/{workspace.slug}/boards",
            json={"name": f"Legacy Board {workspace.slug}"},
            headers=_auth(raw_key),
        )
        assert write_resp.status_code == 201, (
            f"legacy agent denied write on {workspace.slug}: {write_resp.text}"
        )


async def test_human_caller_is_unaffected_by_agent_scoping(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """NEGATIVE CONTROL: the guard keys off the agent ContextVar, which is
    None for human callers. A member must reach every workspace they belong
    to, even while a narrowly-scoped agent exists for the same user."""
    await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    for workspace in (workspace_a, workspace_b):
        read_resp = await raw_key_client.get(
            f"/api/workspaces/{workspace.slug}/boards",
            headers={"X-User-Email": test_user.email},
        )
        assert read_resp.status_code == 200, (
            f"human denied read on {workspace.slug}: {read_resp.text}"
        )

        write_resp = await raw_key_client.post(
            f"/api/workspaces/{workspace.slug}/boards",
            json={"name": f"Human Board {workspace.slug}"},
            headers={"X-User-Email": test_user.email},
        )
        assert write_resp.status_code == 201, (
            f"human denied write on {workspace.slug}: {write_resp.text}"
        )
