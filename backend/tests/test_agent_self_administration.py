# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""An agent API key must not be able to administer the agent it belongs to.

An API key resolves to its *creating user*. Every agent-admin route authorizes
with `agent.created_by_id != user_id`, which is trivially satisfied when the
caller IS that agent's own key. Two escalations follow:

  1. Self-widening. `PATCH /api/agents/{id}` accepts `allowed_workspaces`, so an
     agent grants itself any workspace its creator belongs to — which defeats
     every guard in `test_agent_workspace_scope.py` and
     `test_agent_scope_bypasses.py` at the root rather than at a bypass site.
     `is_active` is writable on the same route, so it can also undo its own
     deactivation.
  2. Unscoped key minting. `POST /api/me/api-keys` returns a raw key with no
     linked Agent row, so `current_agent_id` is never set, the scope guard
     early-returns, and the new credential carries the creating user's FULL
     authority. It also survives revoking the agent.

The intended policy is derived from the runner's actual API surface, which
calls `/api/agents/me{,/config,/budget-status}`, `POST /api/agents/me/heartbeat`,
`/api/agents/{id}/executions*`, `GET /api/me`, and slug-scoped
`/api/workspaces/...` routes. It never patches an agent, mints or rotates a key,
pauses, resumes, or deletes. So self-administration is refused for agent callers
and unchanged for humans.

Auth goes over the REAL API-key path (same approach as the two files named
above): a genuine ApiKey row whose sha256 hash matches `ApiKeyService.verify_key`,
linked to an Agent via `Agent.api_key_id`. The app under test deliberately does
NOT override `get_current_user`, so `app.core.auth` binds the agent and sets the
`current_agent_id` ContextVar exactly as in production. conftest's `agent_client`
fakes that ContextVar via a `get_current_user` override and would bypass the
plumbing under test.
"""

import hashlib
import secrets

import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.agents.team import AgentTeam
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
    name: str = "self-admin-agent",
    is_active: bool = True,
) -> tuple[Agent, str]:
    """Mint a real ApiKey + linked Agent; return (agent, raw `vlr_` token).

    The hash must be sha256(raw) to match ApiKeyService.verify_key.
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
        description="Agent under self-administration test",
        created_by_id=owner.id,
        is_active=is_active,
        api_key_id=api_key.id,
        allowed_workspaces=allowed_workspaces,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent, raw


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
    reason a request is denied — only the self-administration guard can be."""
    return await _make_workspace(
        db_session, test_user, name="Workspace B", slug="workspace-b"
    )


def _auth(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


async def _reload_allowed_workspaces(
    db_session: AsyncSession, agent_id
) -> list[str] | None:
    """Re-read the persisted allowlist, bypassing the identity map.

    `expire_on_commit=False` plus a long-lived fixture session means the Agent
    object this test holds may be the very instance the request mutated. Asking
    the DB for the column directly is the only way to assert on what was
    actually STORED rather than on in-memory state.
    """
    result = await db_session.execute(
        select(Agent.allowed_workspaces).where(Agent.id == agent_id)
    )
    return result.scalar_one()


# --------------------------------------------------------------------------
# Denials — an agent key may not administer itself
# --------------------------------------------------------------------------


async def test_agent_cannot_patch_its_own_allowed_workspaces(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """The root escalation: an agent widening its own workspace allowlist.

    Every scope guard in the codebase reads `Agent.allowed_workspaces`. If the
    agent can write that column, no guard downstream of it means anything —
    it simply adds workspace B and then walks in through the front door.

    The stored-value assertion is the important half: a fix that returns 403 but
    has already committed the widened allowlist would be no fix at all.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.patch(
        f"/api/agents/{agent.id}",
        json={"allowed_workspaces": [workspace_a.slug, workspace_b.slug]},
        headers=_auth(raw_key),
    )

    assert resp.status_code != 422, (
        "request body was rejected by validation, so this test never reached "
        f"the authorization check it claims to measure: {resp.text}"
    )
    assert resp.status_code == 403, (
        "an agent widened its own workspace allowlist: "
        f"{resp.status_code} {resp.text}"
    )

    stored = await _reload_allowed_workspaces(db_session, agent.id)
    assert stored == [workspace_a.slug], (
        f"the agent's stored allowlist was mutated to {stored!r} — the refusal "
        "did not prevent the write"
    )


async def test_agent_cannot_reactivate_itself(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """A deactivated agent must not be able to switch itself back on.

    `is_active` rides the same AgentUpdate schema as the allowlist, so
    deactivation is only as durable as the PATCH guard.

    NOTE ON WHICH LAYER REFUSES: `app.core.auth` (~line 237) already raises
    `ForbiddenError("Agent is deactivated")` before any route runs, so this
    request is refused at AUTH today, not by a self-administration guard. The
    403 assertion therefore passes for a defensible reason already. The
    assertion that carries the weight here is the stored `is_active` value —
    and the explicit check that the refusal is not a 404/422 accident.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug], is_active=False
    )

    resp = await raw_key_client.patch(
        f"/api/agents/{agent.id}",
        json={"is_active": True},
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        "refusal came from routing/validation rather than authorization, so "
        f"this test does not measure what it claims: {resp.status_code} {resp.text}"
    )
    assert resp.status_code == 403, (
        f"a deactivated agent reactivated itself: {resp.status_code} {resp.text}"
    )

    stored = await db_session.execute(
        select(Agent.is_active).where(Agent.id == agent.id)
    )
    assert stored.scalar_one() is False, (
        "the agent is active again — the refusal did not prevent the write"
    )


async def test_agent_cannot_mint_an_api_key(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """The second escalation: an agent minting an unscoped credential.

    `POST /api/me/api-keys` creates a key with no linked Agent row, so
    `current_agent_id` is never set for requests bearing it and the scope guard
    early-returns. The result is a credential with the creating user's full
    authority that also outlives revocation of the agent — a durable escape
    hatch from every scope control in the system.
    """
    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        "/api/me/api-keys",
        json={"name": "minted-by-the-agent"},
        headers=_auth(raw_key),
    )

    assert resp.status_code != 422, (
        f"request body was rejected by validation, not authorization: {resp.text}"
    )
    assert resp.status_code == 403, (
        "an agent minted an unscoped API key carrying its creator's full "
        f"authority: {resp.status_code} {resp.text}"
    )
    assert "raw_key" not in resp.text, (
        "the response body leaked a raw API key despite the refusal"
    )


async def test_agent_cannot_rotate_its_own_key(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """Rotation hands the caller a fresh raw key and destroys the old one.

    For an agent caller that is both a credential-exfiltration primitive and a
    self-inflicted denial of service against the operator, who now holds a key
    the backend has deleted. The runner never calls this route.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        f"/api/agents/{agent.id}/rotate-key",
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        "refusal came from routing/validation rather than authorization: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.status_code == 403, (
        f"an agent rotated its own API key: {resp.status_code} {resp.text}"
    )
    assert "raw_api_key" not in resp.text, (
        "the response body leaked a rotated raw API key despite the refusal"
    )


async def test_agent_cannot_add_itself_to_a_team(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """Team membership binds pipeline roles, and roles drive which cards the
    scheduler will hand out. An agent that can add itself to a team can grant
    itself the reviewer role and then approve its own work, which is the one
    thing the done-gate exists to prevent. Scope confines this to workspaces
    the agent already holds, so it widens privilege rather than tenancy.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )
    team = AgentTeam(
        workspace_id=workspace_a.id,
        name="delivery",
        slug="delivery",
        is_active=True,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    resp = await raw_key_client.post(
        f"/api/workspaces/{workspace_a.slug}/teams/{team.slug}/members",
        json={"agent_id": str(agent.id), "roles": ["reviewer"]},
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        f"expected a refusal, not a routing/validation failure: {resp.text}"
    )
    assert resp.status_code == 403, (
        f"an agent granted itself a team role: {resp.status_code} {resp.text}"
    )


async def test_agent_cannot_delete_an_api_key(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """Key deletion scopes only by user_id, so an agent could revoke its
    OPERATOR's own keys — a denial of service against the humans who
    administer it. Self-revocation goes with it, which is accepted: an agent
    that can burn credentials can also burn the wrong ones.
    """
    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )
    victim = ApiKey(
        user_id=test_user.id,
        name="operators-laptop",
        key_hash=hashlib.sha256(b"vlr_victim").hexdigest(),
        key_prefix="vlr_vict",
    )
    db_session.add(victim)
    await db_session.flush()

    resp = await raw_key_client.delete(
        f"/api/me/api-keys/{victim.id}", headers=_auth(raw_key)
    )

    assert resp.status_code == 403, (
        f"an agent deleted an API key: {resp.status_code} {resp.text}"
    )
    survivor = (
        await db_session.execute(select(ApiKey.id).where(ApiKey.id == victim.id))
    ).scalar_one_or_none()
    assert survivor is not None, (
        "the agent revoked its operator's key despite the refusal"
    )


async def test_agent_cannot_create_workspaces(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    second_user: User,
    workspace_a: Workspace,
):
    """Workspace creation has no slug in its path, so no scope guard sees it —
    and it returns the existing row on a slug collision, for LLM-retry
    resilience. Together that is a cross-tenant oracle: guess a slug and the
    response hands back another tenant's name, id and owner, even though
    reading that workspace is correctly refused.
    """
    foreign = Workspace(
        name="Acme Confidential Q3", slug="acme-secret", created_by=second_user.id
    )
    db_session.add(foreign)
    await db_session.flush()

    _agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        "/api/workspaces",
        json={"name": "guess", "slug": "acme-secret"},
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        f"expected a scope refusal, not a routing/validation failure: {resp.text}"
    )
    assert resp.status_code == 403, (
        "an agent probed a foreign workspace by slug and the response disclosed "
        f"it: {resp.status_code} {resp.text}"
    )
    assert "Acme Confidential Q3" not in resp.text, (
        "the refusal still leaked the foreign workspace's name"
    )


async def test_agent_cannot_pause_itself(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """Pause/resume is an operator lever for stopping a misbehaving runner.

    A runner that can toggle its own `is_paused` can decline work it does not
    want, or un-pause after an operator halts it. The runner never calls this.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        f"/api/agents/{agent.id}/pause",
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        "refusal came from routing/validation rather than authorization: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.status_code == 403, (
        f"an agent paused itself: {resp.status_code} {resp.text}"
    )

    stored = await db_session.execute(
        select(Agent.is_paused).where(Agent.id == agent.id)
    )
    assert stored.scalar_one() is False, (
        "the agent is paused — the refusal did not prevent the write"
    )


async def test_agent_cannot_restart_itself(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """A runner that can restart itself can loop its own process past an operator."""
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.post(
        f"/api/agents/{agent.id}/restart",
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        "refusal came from routing/validation rather than authorization: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.status_code == 403, (
        f"an agent restarted itself: {resp.status_code} {resp.text}"
    )


async def test_agent_cannot_hard_delete_itself(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """Hard delete is unrecoverable — a runner erasing its own audit trail is the
    worst case of self-administration, so the route must refuse before the row moves."""
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await raw_key_client.delete(
        f"/api/agents/{agent.id}/hard",
        headers=_auth(raw_key),
    )

    assert resp.status_code not in (404, 422), (
        "refusal came from routing/validation rather than authorization: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.status_code == 403, (
        f"an agent hard-deleted itself: {resp.status_code} {resp.text}"
    )

    stored = await db_session.execute(select(Agent.id).where(Agent.id == agent.id))
    assert stored.scalar_one_or_none() is not None, (
        "the agent row is gone — the refusal did not prevent the delete"
    )


# --------------------------------------------------------------------------
# Negative controls — these must pass BEFORE and AFTER the fix.
# Without them, "deny every agent-admin route to everyone" would satisfy
# every test above while breaking the operator UI and the live runner.
# --------------------------------------------------------------------------


async def test_human_can_patch_agent_allowed_workspaces(
    client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
    workspace_b: Workspace,
):
    """CONTROL: a human operator must still be able to widen an agent's scope.

    Same route, same body as the first denial test — only the credential
    differs. That is also the proof the denial's body is well-formed.
    """
    agent, _raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    resp = await client.patch(
        f"/api/agents/{agent.id}",
        json={"allowed_workspaces": [workspace_a.slug, workspace_b.slug]},
        headers={"X-User-Email": test_user.email},
    )

    assert resp.status_code == 200, (
        f"a human operator was denied a legitimate agent PATCH: {resp.text}"
    )
    assert resp.json()["allowed_workspaces"] == [workspace_a.slug, workspace_b.slug]

    stored = await _reload_allowed_workspaces(db_session, agent.id)
    assert stored == [workspace_a.slug, workspace_b.slug], (
        f"the human's PATCH returned 200 but stored {stored!r}"
    )


async def test_human_can_mint_an_api_key(
    client: AsyncClient,
    test_user: User,
):
    """CONTROL: humans must still be able to mint API keys — that is how a
    runner gets provisioned in the first place."""
    resp = await client.post(
        "/api/me/api-keys",
        json={"name": "minted-by-a-human"},
        headers={"X-User-Email": test_user.email},
    )

    assert resp.status_code == 201, (
        f"a human operator was denied API key creation: {resp.text}"
    )
    assert resp.json()["raw_key"].startswith("vlr_")


async def test_agent_can_still_read_itself_and_heartbeat(
    raw_key_client: AsyncClient,
    db_session: AsyncSession,
    test_user: User,
    workspace_a: Workspace,
):
    """CONTROL: the routes the live runner actually depends on must keep working.

    This is the test that catches a fix that reaches too far — refusing agent
    callers at the router prefix or on `get_current_agent` would take
    `/api/agents/me` and the heartbeat down with it and stop every runner in
    production. The heartbeat body is the shape the Go runner sends
    (`HeartbeatBody`), not an empty POST, so the parse path is covered too.
    """
    agent, raw_key = await _make_agent_with_key(
        db_session, test_user, allowed_workspaces=[workspace_a.slug]
    )

    me_resp = await raw_key_client.get("/api/agents/me", headers=_auth(raw_key))
    assert me_resp.status_code == 200, (
        f"agent denied a read of its own identity: {me_resp.text}"
    )
    assert me_resp.json()["id"] == str(agent.id)

    hb_resp = await raw_key_client.post(
        "/api/agents/me/heartbeat",
        json={
            "status": "idle",
            "version": "1.0.0",
            "uptime_seconds": 42,
            "cards_processed": 3,
            "cards_failed": 0,
            "hostname": "runner-1",
        },
        headers=_auth(raw_key),
    )
    assert hb_resp.status_code == 200, (
        f"agent denied its own heartbeat — this would stall every runner: "
        f"{hb_resp.text}"
    )
    assert hb_resp.json()["health_status"] == "idle"
