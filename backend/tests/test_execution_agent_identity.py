# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""IDOR: an agent-key caller must not act under a sibling agent's identity.

`/api/agents/{agent_id}/executions*` authorizes on `agent.created_by_id ==
caller user`. One owner commonly runs several runners, so agent A's key
satisfies that check for sibling agent B and can start/update/annotate
executions under B's identity — corrupting B's telemetry, cost attribution and
reservation cleanup.

Mirrors the guard `AssignmentService._verify_caller_owns_agent` already applies
on the reservation path (card f47816b9): agent-key caller ⇒ the URL agent must
equal `current_agent_id`; plain user ⇒ keep the created_by check.

Auth goes over the REAL Bearer `vlr_` path so `app.core.auth` binds the agent
and sets the `current_agent_id` ContextVar exactly as in production — conftest's
`agent_client` fakes that ContextVar and would bypass the plumbing under test.
Every denial has a matching own-agent control, so a fix that denies everything
cannot pass.
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
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole


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
        description="Agent under execution-identity test",
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
async def workspace(db_session: AsyncSession, test_user: User) -> Workspace:
    ws = Workspace(
        name="Execution Identity", slug="execution-identity", created_by=test_user.id
    )
    db_session.add(ws)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=ws.id, user_id=test_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()
    return ws


@pytest_asyncio.fixture
async def siblings(
    db_session: AsyncSession, test_user: User
) -> tuple[Agent, str, Agent, str]:
    """Two agents created by the SAME user, each with its own API key.

    Shared ownership is the whole point: `created_by_id` can never tell these
    two apart, so only the key linkage can.
    """
    agent_a, key_a = await _make_agent_with_key(db_session, test_user, name="runner-a")
    agent_b, key_b = await _make_agent_with_key(db_session, test_user, name="runner-b")
    return agent_a, key_a, agent_b, key_b


async def _start_execution(
    client: AsyncClient, agent: Agent, raw_key: str, workspace: Workspace
) -> str:
    resp = await client.post(
        f"/api/agents/{agent.id}/executions",
        json={
            "workspace_slug": workspace.slug,
            "action": "implement",
            "input_summary": "own work",
        },
        headers=_auth(raw_key),
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


# --------------------------------------------------------------------------
# Exploit pins — agent A's key acting under sibling agent B
# --------------------------------------------------------------------------


async def test_start_execution_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings, workspace: Workspace
):
    _agent_a, key_a, agent_b, _key_b = siblings

    resp = await raw_key_client.post(
        f"/api/agents/{agent_b.id}/executions",
        json={
            "workspace_slug": workspace.slug,
            "action": "implement",
            "input_summary": "forged under B",
        },
        headers=_auth(key_a),
    )

    assert resp.status_code == 403, (
        "agent A's key started an execution under sibling agent B: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.json()["error_code"] == "agent_identity_mismatch"


async def test_update_execution_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings, workspace: Workspace
):
    _agent_a, key_a, agent_b, key_b = siblings
    execution_id = await _start_execution(raw_key_client, agent_b, key_b, workspace)

    resp = await raw_key_client.patch(
        f"/api/agents/{agent_b.id}/executions/{execution_id}",
        json={"status": "failed", "error_message": "forged failure"},
        headers=_auth(key_a),
    )

    assert resp.status_code == 403, (
        "agent A's key updated sibling agent B's execution: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.json()["error_code"] == "agent_identity_mismatch"


async def test_record_warning_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings, workspace: Workspace
):
    _agent_a, key_a, agent_b, key_b = siblings
    execution_id = await _start_execution(raw_key_client, agent_b, key_b, workspace)

    resp = await raw_key_client.post(
        f"/api/agents/{agent_b.id}/executions/{execution_id}/warnings",
        json={"kind": "forged", "message": "not from B"},
        headers=_auth(key_a),
    )

    assert resp.status_code == 403, (
        "agent A's key wrote a warning onto sibling agent B's execution: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.json()["error_code"] == "agent_identity_mismatch"


async def test_record_tool_invocations_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings, workspace: Workspace
):
    _agent_a, key_a, agent_b, key_b = siblings
    execution_id = await _start_execution(raw_key_client, agent_b, key_b, workspace)

    resp = await raw_key_client.post(
        f"/api/agents/{agent_b.id}/executions/{execution_id}/tool-invocations",
        json=[{"tool_name": "forged_tool", "status": "success"}],
        headers=_auth(key_a),
    )

    assert resp.status_code == 403, (
        "agent A's key recorded invocations onto sibling agent B's execution: "
        f"{resp.status_code} {resp.text}"
    )
    assert resp.json()["error_code"] == "agent_identity_mismatch"


async def test_list_executions_denies_sibling_agent(
    raw_key_client: AsyncClient, siblings, workspace: Workspace
):
    """Reads leak too: B's input prompts and cost rows are not A's to see."""
    _agent_a, key_a, agent_b, key_b = siblings
    await _start_execution(raw_key_client, agent_b, key_b, workspace)

    resp = await raw_key_client.get(
        f"/api/agents/{agent_b.id}/executions", headers=_auth(key_a)
    )

    assert resp.status_code == 403, (
        f"agent A's key listed sibling agent B's executions: {resp.text}"
    )
    assert resp.json()["error_code"] == "agent_identity_mismatch"


# --------------------------------------------------------------------------
# Negative controls — the runner's own flows must stay green
# --------------------------------------------------------------------------


async def test_agent_key_can_drive_its_own_execution_end_to_end(
    raw_key_client: AsyncClient, siblings, workspace: Workspace
):
    """The production runner path: every endpoint under the agent's own key."""
    agent_a, key_a, _agent_b, _key_b = siblings
    execution_id = await _start_execution(raw_key_client, agent_a, key_a, workspace)

    warning = await raw_key_client.post(
        f"/api/agents/{agent_a.id}/executions/{execution_id}/warnings",
        json={"kind": "deadline", "message": "slow stage"},
        headers=_auth(key_a),
    )
    assert warning.status_code == 202, warning.text

    invocations = await raw_key_client.post(
        f"/api/agents/{agent_a.id}/executions/{execution_id}/tool-invocations",
        json=[{"tool_name": "read_file", "status": "success"}],
        headers=_auth(key_a),
    )
    assert invocations.status_code == 201, invocations.text

    listed = await raw_key_client.get(
        f"/api/agents/{agent_a.id}/executions", headers=_auth(key_a)
    )
    assert listed.status_code == 200, listed.text

    completed = await raw_key_client.patch(
        f"/api/agents/{agent_a.id}/executions/{execution_id}",
        json={"status": "completed", "output_summary": "done"},
        headers=_auth(key_a),
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"


async def test_owner_user_without_agent_key_keeps_created_by_access(
    client: AsyncClient, siblings, workspace: Workspace
):
    """A plain human/MCP caller (no linked agent) still reaches agents it created.

    `client` authenticates as `test_user` via X-User-Email, so `current_agent_id`
    is unset and the created_by branch is what must answer.
    """
    _agent_a, _key_a, agent_b, _key_b = siblings

    resp = await client.post(
        f"/api/agents/{agent_b.id}/executions",
        json={
            "workspace_slug": workspace.slug,
            "action": "manual",
            "input_summary": "owner-triggered",
        },
    )

    assert resp.status_code == 201, resp.text


async def test_foreign_user_still_denied(
    client: AsyncClient, db_session: AsyncSession, workspace: Workspace
):
    """The pre-existing created_by guard must not regress into an allow.

    404, not 403: a stranger must not be able to use the response to confirm
    that an agent id exists (pinned by tests/routers/agents/test_executions.py).
    """
    stranger = User(email="stranger@example.com", name="Stranger")
    db_session.add(stranger)
    await db_session.flush()
    foreign_agent, _raw = await _make_agent_with_key(
        db_session, stranger, name="foreign-runner"
    )

    resp = await client.post(
        f"/api/agents/{foreign_agent.id}/executions",
        json={
            "workspace_slug": workspace.slug,
            "action": "implement",
            "input_summary": "not yours",
        },
    )

    assert resp.status_code == 404, resp.text
