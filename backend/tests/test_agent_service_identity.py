# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""IDOR: an agent-key caller must not read or drive a sibling agent (card 3e1e5f7a).

`AgentService` authorizes every by-id method on `agent.created_by_id == user_id`.
An agent key resolves to its creating user, and one owner commonly runs several
runners — so agent A's key satisfies that check for sibling agent B.

Five of the seven service sites are unreachable by an agent key because their
routes carry `forbid_agent_callers` (rotate-key, PATCH, DELETE, pause/resume,
and — since card 0da7abdd — poll). Three are NOT: GET `/{id}`, GET
`/{id}/export-config`, GET `/{id}/budget-status`. Those leak a sibling's
config, spend and key prefix, so the service-level identity check is what
holds them.

Auth goes over the REAL Bearer `vlr_` path so `app.core.auth` binds the agent
and sets the `current_agent_id` ContextVar exactly as in production — conftest's
`agent_client` fakes that ContextVar and would bypass the plumbing under test.
Every denial has a matching own-agent control, so a fix that denies everything
cannot pass.

Foreign-USER callers must keep their current 404 (not 403): the agent-admin
surface answers a stranger with "not found" so responses cannot enumerate agent
ids. That status is preserved, not harmonized.
"""

import hashlib
import secrets

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.user import User


async def _make_agent_with_key(
    db_session: AsyncSession, owner: User, *, name: str
) -> tuple[Agent, str]:
    """Mint a real ApiKey + linked Agent; return (agent, raw `vlr_` token).

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
        description="Agent under service-identity test",
        created_by_id=owner.id,
        is_active=True,
        api_key_id=api_key.id,
        allowed_workspaces=None,
    )
    db_session.add(agent)
    await db_session.flush()
    return agent, raw


def _auth(raw_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {raw_key}"}


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
async def siblings(
    db_session: AsyncSession, test_user: User
) -> tuple[Agent, str, Agent, str]:
    """Two agents created by the SAME user, each with its own API key.

    Shared ownership is the whole point: `created_by_id` can never tell these
    two apart, so only the key linkage can.
    """
    agent_a, key_a = await _make_agent_with_key(db_session, test_user, name="svc-a")
    agent_b, key_b = await _make_agent_with_key(db_session, test_user, name="svc-b")
    return agent_a, key_a, agent_b, key_b


# --------------------------------------------------------------------------
# Exploit pins — agent A's key acting under sibling agent B
# --------------------------------------------------------------------------


async def test_get_agent_denies_sibling_agent(raw_key_client: AsyncClient, siblings):
    agent_a, key_a, agent_b, _ = siblings

    resp = await raw_key_client.get(f"/api/agents/{agent_b.id}", headers=_auth(key_a))

    assert resp.status_code == 403, resp.text
    assert resp.json()["error_code"] == "agent_identity_mismatch"


async def test_export_config_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings
):
    """The ZIP bundles a launch config; a sibling must not be able to fetch it."""
    agent_a, key_a, agent_b, _ = siblings

    resp = await raw_key_client.get(
        f"/api/agents/{agent_b.id}/export-config", headers=_auth(key_a)
    )

    assert resp.status_code == 403, resp.text


async def test_budget_status_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings
):
    agent_a, key_a, agent_b, _ = siblings

    resp = await raw_key_client.get(
        f"/api/agents/{agent_b.id}/budget-status", headers=_auth(key_a)
    )

    assert resp.status_code == 403, resp.text
    assert resp.json()["error_code"] == "agent_identity_mismatch"


async def test_poll_denies_sibling_agent(raw_key_client: AsyncClient, siblings):
    """Driving a sibling's work loop is a write, and the worst of the three.

    Still 403, but the route-level `forbid_agent_callers` now rejects first, so
    the service's identity check is never reached and the code is the generic
    agent-admin refusal rather than `agent_identity_mismatch` (card 0da7abdd).
    The sibling exploit stays closed either way; the parametrized closed-list
    test below is what pins the stronger guarantee.
    """
    agent_a, key_a, agent_b, _ = siblings

    resp = await raw_key_client.post(
        f"/api/agents/{agent_b.id}/poll", headers=_auth(key_a)
    )

    assert resp.status_code == 403, resp.text


# --------------------------------------------------------------------------
# Negative controls — the normal runner self-administration path stays open
# --------------------------------------------------------------------------


async def test_get_own_agent_under_own_key_allowed(
    raw_key_client: AsyncClient, siblings
):
    agent_a, key_a, _, _ = siblings

    resp = await raw_key_client.get(f"/api/agents/{agent_a.id}", headers=_auth(key_a))

    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == str(agent_a.id)


async def test_export_own_config_under_own_key_allowed(
    raw_key_client: AsyncClient, siblings
):
    agent_a, key_a, _, _ = siblings

    resp = await raw_key_client.get(
        f"/api/agents/{agent_a.id}/export-config", headers=_auth(key_a)
    )

    assert resp.status_code == 200, resp.text


async def test_own_budget_status_under_own_key_allowed(
    raw_key_client: AsyncClient, siblings
):
    agent_a, key_a, _, _ = siblings

    resp = await raw_key_client.get(
        f"/api/agents/{agent_a.id}/budget-status", headers=_auth(key_a)
    )

    assert resp.status_code == 200, resp.text


async def test_poll_by_owner_user_reaches_offline_check(
    raw_key_client: AsyncClient, siblings, test_user: User
):
    """Poll stays reachable for the operator — the guard closes agent keys only.

    Replaces an own-key variant of this control: `/poll` joined the
    `forbid_agent_callers` closed list (card 0da7abdd), so an agent key now gets
    403 on its OWN agent and can no longer prove the route is alive. The
    creating human, holding no agent key, is the caller the route actually
    serves (frontend `pollAgent`), so it carries the control instead.

    503 (agent offline) proves the request got past authorization — no WS
    connection exists in this test, which is the expected next failure.
    """
    agent_a, _, _, _ = siblings

    resp = await raw_key_client.post(
        f"/api/agents/{agent_a.id}/poll", headers={"X-User-Email": test_user.email}
    )

    assert resp.status_code == 503, resp.text


# --------------------------------------------------------------------------
# Foreign plain-user callers keep 404 — the guard must not turn it into 403
# --------------------------------------------------------------------------


async def test_foreign_user_still_gets_404_on_get(
    raw_key_client: AsyncClient, db_session: AsyncSession, siblings
):
    _, _, agent_b, _ = siblings
    stranger = User(email="stranger-svc@example.com", name="Stranger")
    db_session.add(stranger)
    await db_session.flush()

    resp = await raw_key_client.get(
        f"/api/agents/{agent_b.id}", headers={"X-User-Email": stranger.email}
    )

    assert resp.status_code == 404, resp.text


async def test_foreign_user_still_gets_404_on_budget_status(
    raw_key_client: AsyncClient, db_session: AsyncSession, siblings
):
    _, _, agent_b, _ = siblings
    stranger = User(email="stranger-budget@example.com", name="Stranger")
    db_session.add(stranger)
    await db_session.flush()

    resp = await raw_key_client.get(
        f"/api/agents/{agent_b.id}/budget-status",
        headers={"X-User-Email": stranger.email},
    )

    assert resp.status_code == 404, resp.text


async def test_foreign_user_still_gets_404_on_poll(
    raw_key_client: AsyncClient, db_session: AsyncSession, siblings
):
    _, _, agent_b, _ = siblings
    stranger = User(email="stranger-poll@example.com", name="Stranger")
    db_session.add(stranger)
    await db_session.flush()

    resp = await raw_key_client.post(
        f"/api/agents/{agent_b.id}/poll", headers={"X-User-Email": stranger.email}
    )

    assert resp.status_code == 404, resp.text


async def test_owner_user_without_agent_key_still_allowed(
    raw_key_client: AsyncClient, siblings, test_user: User
):
    """The creating human, holding no agent key, keeps full access."""
    _, _, agent_b, _ = siblings

    resp = await raw_key_client.get(
        f"/api/agents/{agent_b.id}", headers={"X-User-Email": test_user.email}
    )

    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------
# The four service sites that deliberately keep the plain created_by check do
# so because their ROUTES carry forbid_agent_callers. Pin that, or dropping the
# route dependency would silently reopen the IDOR behind a comment saying it
# cannot happen. Sibling AND own agent are both refused: these routes exclude
# agent keys entirely, they are not an identity check.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path_suffix,body",
    [
        ("post", "/rotate-key", None),
        ("post", "/pause", None),
        ("post", "/resume", None),
        ("post", "/poll", None),
        ("patch", "", {"description": "hijacked"}),
        ("delete", "", None),
    ],
)
async def test_self_administration_routes_refuse_agent_keys(
    raw_key_client: AsyncClient, siblings, method: str, path_suffix: str, body
):
    agent_a, key_a, agent_b, _ = siblings

    for target in (agent_b, agent_a):
        resp = await raw_key_client.request(
            method.upper(),
            f"/api/agents/{target.id}{path_suffix}",
            json=body,
            headers=_auth(key_a),
        )
        assert resp.status_code == 403, f"{method} {target.name}: {resp.text}"
