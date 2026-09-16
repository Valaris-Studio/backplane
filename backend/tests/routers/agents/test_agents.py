# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.prompt_config import AgentPromptConfig
from app.models.agents.team import AgentTeam, AgentTeamMember
from app.models.user import User
from app.models.workspace import Workspace
from app.utils import utcnow


BASE_URL = "/api/agents"

VALID_AGENT = {
    "name": "standup-bot",
    "agent_type": "secretary",
    "description": "Generates daily standups",
    # Non-empty allowlist is required since 2026-04-19 (B3/B4 Option B).
    # Tests that need a specific slug override this key explicitly.
    "allowed_workspaces": ["default"],
}


async def test_list_agents_empty(client: AsyncClient, test_user: User):
    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_create_agent_success(client: AsyncClient, test_user: User):
    response = await client.post(BASE_URL, json=VALID_AGENT)
    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "standup-bot"
    assert data["agent_type"] == "secretary"
    assert data["description"] == "Generates daily standups"
    assert data["is_active"] is True
    assert data["created_by_id"] == str(test_user.id)
    assert "id" in data
    assert "created_at" in data
    assert "api_key_prefix" in data


async def test_create_agent_generates_api_key(client: AsyncClient, test_user: User):
    response = await client.post(BASE_URL, json=VALID_AGENT)
    assert response.status_code == 201
    data = response.json()
    assert "raw_api_key" in data
    assert data["raw_api_key"].startswith("vlr_")
    assert "api_key_prefix" in data


async def test_create_agent_with_scoped_permissions(client: AsyncClient, test_user: User):
    payload = {
        **VALID_AGENT,
        "allowed_workspaces": ["default", "staging"],
        "allowed_actions": ["read:*", "write:cards"],
        "max_requests_per_minute": 50,
    }
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 201
    data = response.json()
    assert data["allowed_workspaces"] == ["default", "staging"]
    assert data["allowed_actions"] == ["read:*", "write:cards"]
    assert data["max_requests_per_minute"] == 50


async def test_create_agent_invalid_type(client: AsyncClient, test_user: User):
    payload = {**VALID_AGENT, "agent_type": "invalid"}
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 422


async def test_create_agent_missing_name(client: AsyncClient, test_user: User):
    payload = {"agent_type": "coding", "description": "test"}
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 422


# B3/B4 null-allowlist decision (Option B, 2026-04-19): creating an agent
# without an explicit allowlist silently produced an orphan runner — invisible
# to every workspace, because the filter layer already treats null as "none."
# Reject at the boundary instead so the caller gets a loud error and can
# supply a slug. See memory/plan.md §3.1b Thread B.
async def test_create_agent_rejects_null_allowed_workspaces(
    client: AsyncClient, test_user: User
):
    payload = {
        "name": "orphan-bot",
        "agent_type": "coding",
        "allowed_workspaces": None,
    }
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 422
    assert "allowed_workspaces" in response.text


async def test_create_agent_rejects_empty_allowed_workspaces(
    client: AsyncClient, test_user: User
):
    payload = {
        "name": "orphan-bot",
        "agent_type": "coding",
        "allowed_workspaces": [],
    }
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 422
    assert "allowed_workspaces" in response.text


async def test_create_agent_rejects_missing_allowed_workspaces(
    client: AsyncClient, test_user: User
):
    # No key at all — same shape as the pre-fix VALID_AGENT that silently
    # orphaned runners.
    payload = {"name": "orphan-bot", "agent_type": "coding"}
    response = await client.post(BASE_URL, json=payload)
    assert response.status_code == 422


# Update path: null means "don't change this field" (PATCH semantics), but
# empty list is still rejected — you can narrow, you can't strip.
async def test_update_agent_rejects_empty_allowed_workspaces(
    client: AsyncClient, test_user: User
):
    create_resp = await client.post(
        BASE_URL, json={**VALID_AGENT, "allowed_workspaces": ["my-ws"]}
    )
    agent_id = create_resp.json()["id"]
    response = await client.patch(
        f"{BASE_URL}/{agent_id}", json={"allowed_workspaces": []}
    )
    assert response.status_code == 422


async def test_update_agent_accepts_null_allowed_workspaces_as_noop(
    client: AsyncClient, test_user: User
):
    create_resp = await client.post(
        BASE_URL, json={**VALID_AGENT, "allowed_workspaces": ["my-ws"]}
    )
    agent_id = create_resp.json()["id"]
    # Null in AgentUpdate = "don't change this field" — not a reset to empty.
    response = await client.patch(
        f"{BASE_URL}/{agent_id}", json={"description": "bumped"}
    )
    assert response.status_code == 200
    assert response.json()["allowed_workspaces"] == ["my-ws"]


async def test_get_agent_success(client: AsyncClient, test_user: User):
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == agent_id
    assert data["name"] == "standup-bot"


async def test_get_agent_not_found(client: AsyncClient, test_user: User):
    fake_id = uuid.uuid4()
    response = await client.get(f"{BASE_URL}/{fake_id}")
    assert response.status_code == 404


async def test_update_agent_success(client: AsyncClient, test_user: User):
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]

    response = await client.patch(
        f"{BASE_URL}/{agent_id}",
        json={"name": "updated-bot", "description": "Updated description"},
    )
    assert response.status_code == 200
    data = response.json()
    assert data["name"] == "updated-bot"
    assert data["description"] == "Updated description"
    assert data["agent_type"] == "secretary"


async def test_update_agent_not_found(client: AsyncClient, test_user: User):
    fake_id = uuid.uuid4()
    response = await client.patch(f"{BASE_URL}/{fake_id}", json={"name": "nope"})
    assert response.status_code == 404


async def test_deactivate_agent(client: AsyncClient, test_user: User):
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]

    response = await client.delete(f"{BASE_URL}/{agent_id}")
    assert response.status_code == 200
    data = response.json()
    assert data["is_active"] is False

    get_resp = await client.get(f"{BASE_URL}/{agent_id}")
    assert get_resp.json()["is_active"] is False


async def test_list_agents_excludes_inactive(client: AsyncClient, test_user: User):
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]
    await client.delete(f"{BASE_URL}/{agent_id}")

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert len(response.json()) == 0


async def test_list_agents_include_inactive(client: AsyncClient, test_user: User):
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]
    await client.delete(f"{BASE_URL}/{agent_id}")

    response = await client.get(f"{BASE_URL}?include_inactive=true")
    assert response.status_code == 200
    assert len(response.json()) == 1


async def test_list_agents_include_inactive_returns_deactivated(
    client: AsyncClient, test_user: User
):
    """B12: operators must be able to see deactivated runners to rehydrate them."""
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]
    await client.delete(f"{BASE_URL}/{agent_id}")

    response = await client.get(f"{BASE_URL}?include_inactive=true")
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["id"] == agent_id
    assert body[0]["is_active"] is False


async def test_list_agents_default_hides_inactive(client: AsyncClient, test_user: User):
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]
    await client.delete(f"{BASE_URL}/{agent_id}")

    response = await client.get(BASE_URL)
    assert response.status_code == 200
    assert response.json() == []


async def test_create_agent_idempotent_returns_existing(
    client: AsyncClient, test_user: User
):
    """B12: re-creating an agent by same name for same owner returns the existing
    row instead of spawning a duplicate. Matches feedback_idempotent_mutations.md."""
    first = await client.post(BASE_URL, json=VALID_AGENT)
    assert first.status_code == 201
    first_body = first.json()

    second = await client.post(BASE_URL, json=VALID_AGENT)
    assert second.status_code == 200
    second_body = second.json()

    assert second_body["id"] == first_body["id"]
    assert second_body["raw_api_key"] is None
    assert second_body["api_key_prefix"] == first_body["api_key_prefix"]


async def test_create_agent_idempotent_reactivates_deactivated(
    client: AsyncClient, test_user: User
):
    """B12: re-creating an agent after deactivation flips is_active back on."""
    first = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = first.json()["id"]
    deactivate = await client.delete(f"{BASE_URL}/{agent_id}")
    assert deactivate.json()["is_active"] is False

    second = await client.post(BASE_URL, json=VALID_AGENT)
    assert second.status_code == 200
    body = second.json()
    assert body["id"] == agent_id
    assert body["is_active"] is True
    assert body["raw_api_key"] is None


async def test_create_agent_different_user_same_name_creates_new(
    db_session: AsyncSession, test_user: User, second_user: User
):
    """B12: idempotency is scoped per owner — two users may each own a 'foo'."""
    from app.schemas.agents.agent import AgentCreate
    from app.services.agents.agent import AgentService

    service = AgentService(db_session)
    payload = AgentCreate(
        name="foo", agent_type=AgentType.coding, allowed_workspaces=["default"]
    )
    first_agent, _, _ = await service.create_agent(payload, test_user.id)
    second_agent, second_key, second_raw = await service.create_agent(payload, second_user.id)

    assert first_agent.id != second_agent.id
    assert first_agent.created_by_id == test_user.id
    assert second_agent.created_by_id == second_user.id
    assert second_key is not None
    assert second_raw is not None


async def test_rotate_agent_key_success(
    client: AsyncClient, test_user: User, db_session: AsyncSession
):
    import hashlib

    from app.models.api_key import ApiKey
    from sqlalchemy import select

    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]
    original_raw = create_resp.json()["raw_api_key"]
    original_prefix = create_resp.json()["api_key_prefix"]
    original_hash = hashlib.sha256(original_raw.encode()).hexdigest()

    response = await client.post(f"{BASE_URL}/{agent_id}/rotate-key")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == agent_id
    assert data["raw_api_key"].startswith("vlr_")
    assert data["raw_api_key"] != original_raw
    assert data["api_key_prefix"] != original_prefix

    # Old key row is deleted
    stale = (
        await db_session.execute(select(ApiKey).where(ApiKey.key_hash == original_hash))
    ).scalar_one_or_none()
    assert stale is None

    # Agent now points at the new key
    new_hash = hashlib.sha256(data["raw_api_key"].encode()).hexdigest()
    fresh = (
        await db_session.execute(select(ApiKey).where(ApiKey.key_hash == new_hash))
    ).scalar_one_or_none()
    assert fresh is not None

    agent_row = (
        await db_session.execute(select(Agent).where(Agent.id == uuid.UUID(agent_id)))
    ).scalar_one()
    assert agent_row.api_key_id == fresh.id


async def test_rotate_agent_key_not_found(client: AsyncClient, test_user: User):
    fake_id = uuid.uuid4()
    response = await client.post(f"{BASE_URL}/{fake_id}/rotate-key")
    assert response.status_code == 404


async def test_newly_created_agent_has_no_last_rotated_at(
    client: AsyncClient, test_user: User
):
    response = await client.post(BASE_URL, json=VALID_AGENT)
    assert response.status_code == 201
    data = response.json()
    assert "last_key_rotated_at" in data
    assert data["last_key_rotated_at"] is None

    agent_id = data["id"]
    get_resp = await client.get(f"{BASE_URL}/{agent_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["last_key_rotated_at"] is None


async def test_rotate_api_key_sets_last_rotated_at(
    client: AsyncClient, test_user: User
):
    before = utcnow()
    create_resp = await client.post(BASE_URL, json=VALID_AGENT)
    agent_id = create_resp.json()["id"]
    assert create_resp.json()["last_key_rotated_at"] is None

    rotate_resp = await client.post(f"{BASE_URL}/{agent_id}/rotate-key")
    assert rotate_resp.status_code == 200
    rotated_at_str = rotate_resp.json()["last_key_rotated_at"]
    assert rotated_at_str is not None

    get_resp = await client.get(f"{BASE_URL}/{agent_id}")
    assert get_resp.status_code == 200
    fetched_str = get_resp.json()["last_key_rotated_at"]
    assert fetched_str is not None

    from datetime import datetime

    fetched = datetime.fromisoformat(fetched_str.replace("Z", "+00:00"))
    assert fetched.year == before.year
    assert fetched.month == before.month
    assert fetched.day == before.day


# --- /me and heartbeat tests ---


async def test_get_agent_me_success(agent_client: AsyncClient, test_agent: Agent):
    response = await agent_client.get(f"{BASE_URL}/me")
    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(test_agent.id)
    assert data["name"] == test_agent.name
    assert data["agent_type"] == test_agent.agent_type.value
    assert data["is_active"] is True
    assert "allowed_workspaces" in data
    assert "last_seen_at" in data


async def test_get_agent_me_no_agent(client: AsyncClient, test_user: User):
    response = await client.get(f"{BASE_URL}/me")
    assert response.status_code == 404


async def test_heartbeat_success(agent_client: AsyncClient, test_agent: Agent):
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat")
    assert response.status_code == 200
    data = response.json()
    assert data["last_seen_at"] is not None


async def test_heartbeat_updates_timestamp(agent_client: AsyncClient, test_agent: Agent):
    r1 = await agent_client.post(f"{BASE_URL}/me/heartbeat")
    t1 = r1.json()["last_seen_at"]
    r2 = await agent_client.post(f"{BASE_URL}/me/heartbeat")
    t2 = r2.json()["last_seen_at"]
    assert t2 >= t1


async def test_heartbeat_with_health_body(agent_client: AsyncClient, test_agent: Agent):
    body = {
        "version": "1.0.0",
        "status": "idle",
        "uptime_seconds": 3600,
        "cards_processed": 5,
        "cards_failed": 1,
        "hostname": "macbook-pro",
    }
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat", json=body)
    assert response.status_code == 200
    data = response.json()
    assert data["last_seen_at"] is not None
    assert data["health_status"] == "idle"
    assert data["health_version"] == "1.0.0"
    assert data["health_uptime_seconds"] == 3600
    assert data["health_cards_processed"] == 5
    assert data["health_cards_failed"] == 1


async def test_heartbeat_no_body_backward_compat(agent_client: AsyncClient, test_agent: Agent):
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat")
    assert response.status_code == 200
    data = response.json()
    assert data["last_seen_at"] is not None
    assert data["health_status"] is None


async def test_heartbeat_sets_working_status(agent_client: AsyncClient, test_agent: Agent):
    body = {"status": "working", "current_card_id": "card-abc-123"}
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat", json=body)
    assert response.status_code == 200
    data = response.json()
    assert data["health_status"] == "working"
    assert data["health_current_card_id"] == "card-abc-123"


async def test_heartbeat_clears_card_on_idle(agent_client: AsyncClient, test_agent: Agent):
    await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={"status": "working", "current_card_id": "card-abc-123"},
    )
    response = await agent_client.post(
        f"{BASE_URL}/me/heartbeat",
        json={"status": "idle"},
    )
    data = response.json()
    assert data["health_status"] == "idle"
    assert data["health_current_card_id"] is None


async def test_heartbeat_with_error_info(agent_client: AsyncClient, test_agent: Agent):
    body = {
        "status": "idle",
        "last_error": "git push failed: permission denied",
        "last_error_at": "2026-04-11T12:00:00Z",
    }
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat", json=body)
    assert response.status_code == 200
    data = response.json()
    assert data["health_last_error"] == "git push failed: permission denied"
    assert data["health_last_error_at"] is not None


async def test_heartbeat_persists_sensor_catalog(agent_client: AsyncClient, test_agent: Agent):
    body = {
        "status": "idle",
        "sensor_catalog": [
            {
                "name": "go-test",
                "kind": "computational",
                "default_config": {"packages": "./...", "timeout": "120s", "tags": ""},
                "description": "Runs Go tests.",
            }
        ],
    }
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat", json=body)
    assert response.status_code == 200
    data = response.json()
    assert data["sensor_catalog"] is not None
    assert len(data["sensor_catalog"]) == 1
    assert data["sensor_catalog"][0]["name"] == "go-test"
    assert data["sensor_catalog"][0]["kind"] == "computational"


async def test_heartbeat_sensor_catalog_optional(agent_client: AsyncClient, test_agent: Agent):
    # Older agents that don't send sensor_catalog must keep working — the field is optional.
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat", json={"status": "idle"})
    assert response.status_code == 200
    data = response.json()
    assert data["sensor_catalog"] is None


async def test_http_heartbeat_logs_deprecation_warning(
    agent_client: AsyncClient, test_agent: Agent, caplog
):
    """WS-2: HTTP heartbeat is deprecated in favor of WS frames. Each hit
    must emit a WARN with the agent id so operators can identify which
    runners still need upgrading before release N+1 flips this to a 403."""
    import logging

    caplog.set_level(logging.WARNING, logger="app.routers.agents.agents")
    response = await agent_client.post(f"{BASE_URL}/me/heartbeat")
    assert response.status_code == 200

    deprecation_records = [
        r
        for r in caplog.records
        if "deprecated HTTP heartbeat" in r.getMessage()
        and str(test_agent.id) in r.getMessage()
    ]
    assert len(deprecation_records) >= 1


# --- /me/config composite endpoint tests ---


async def test_get_agent_config_success(agent_client: AsyncClient, test_agent: Agent):
    response = await agent_client.get(f"{BASE_URL}/me/config")
    assert response.status_code == 200
    data = response.json()

    # Identity fields
    assert data["agent_id"] == str(test_agent.id)
    assert data["name"] == test_agent.name
    assert data["agent_type"] == test_agent.agent_type.value
    assert data["description"] == test_agent.description
    assert data["is_active"] is True

    # Authorization fields
    assert "allowed_workspaces" in data
    assert "allowed_actions" in data
    assert data["max_requests_per_minute"] == 100

    # Budget fields (no budget set, no executions)
    assert data["budget_usd"] is None
    assert data["spent_usd"] == 0.0
    assert data["remaining_usd"] is None
    assert data["budget_exceeded"] is False

    # Team fields (no team assigned)
    assert data["team_id"] is None
    assert data["team_name"] is None
    assert data["team_role"] is None
    assert data["team_roles"] == []
    assert data["board_id"] is None

    # Prompt configs (none)
    assert data["prompt_configs"] == []


async def test_get_agent_config_with_team(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_user: User,
    test_workspace: Workspace,
    test_board,
):
    # Create a team and add the agent as orchestrator
    team = AgentTeam(
        name="Alpha Team",
        description="Test team",
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        created_by_id=test_user.id,
    )
    db_session.add(team)
    await db_session.flush()

    member = AgentTeamMember(
        team_id=team.id,
        agent_id=test_agent.id,
        roles=["orchestrator"],
    )
    db_session.add(member)
    await db_session.flush()

    response = await agent_client.get(f"{BASE_URL}/me/config")
    assert response.status_code == 200
    data = response.json()

    assert data["team_id"] == str(team.id)
    assert data["team_name"] == "Alpha Team"
    assert data["team_role"] == "orchestrator"
    assert data["team_roles"] == ["orchestrator"]
    assert data["board_id"] == str(test_board.id)


async def test_get_agent_config_with_budget(
    agent_client: AsyncClient,
    db_session: AsyncSession,
    test_agent: Agent,
    test_workspace: Workspace,
):
    # Set budget on agent
    test_agent.budget_usd = 100.0
    await db_session.flush()

    # Create executions with cost
    for cost in [10.0, 15.0, 5.0]:
        execution = AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            action="implement",
            status=ExecutionStatus.completed,
            input_summary="test",
            cost_usd=cost,
            started_at=utcnow(),
        )
        db_session.add(execution)
    await db_session.flush()

    response = await agent_client.get(f"{BASE_URL}/me/config")
    assert response.status_code == 200
    data = response.json()

    assert data["budget_usd"] == 100.0
    assert data["spent_usd"] == 30.0
    assert data["remaining_usd"] == 70.0
    assert data["budget_exceeded"] is False


async def test_get_agent_config_unauthenticated(client: AsyncClient, test_user: User):
    """Regular user client without agent context should get 404 (no agent linked)."""
    response = await client.get(f"{BASE_URL}/me/config")
    assert response.status_code == 404


# --- export-config tests ---
#
# Export returns a ZIP bundle containing the runner YAML and the MCP
# config JSON so the operator drops both files in one directory and
# launches the runner. The YAML's mcp_config_path is a relative sibling
# reference, eliminating the raw-filesystem-path footgun (B10 in
# audits/runner-launch-walkthrough-2026-04-18.md).


def _read_zip(body: bytes) -> dict[str, str]:
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        return {name: zf.read(name).decode() for name in zf.namelist()}


async def test_export_agent_config_returns_zip_bundle(
    client: AsyncClient, test_user: User
):
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "budget_usd": 25.0, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/zip")
    assert "standup-bot" in response.headers.get("content-disposition", "")

    files = _read_zip(response.content)
    assert "runner-standup-bot.yaml" in files
    assert "mcp-config-standup-bot.json" in files


async def test_export_yaml_references_sibling_mcp_config(
    client: AsyncClient, test_user: User
):
    """B10: mcp_config_path must be a relative sibling, not a placeholder path."""
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    files = _read_zip(response.content)
    yaml_body = files["runner-standup-bot.yaml"]

    assert 'mcp_config_path: "./mcp-config-standup-bot.json"' in yaml_body
    assert "/path/to/mcp-config.json" not in yaml_body


async def test_export_yaml_omits_role_field(client: AsyncClient, test_user: User):
    """B8: roles come from team membership, not the YAML — must not be exported."""
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    files = _read_zip(response.content)
    yaml_body = files["runner-standup-bot.yaml"]

    assert "\nrole:" not in yaml_body
    assert 'role: "orchestrator"' not in yaml_body


async def test_export_yaml_default_git_base_dir(client: AsyncClient, test_user: User):
    """B9: git.base_dir defaults to ~/.valaris/repos, not a /path/to/repos placeholder."""
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    files = _read_zip(response.content)
    yaml_body = files["runner-standup-bot.yaml"]

    assert 'base_dir: "~/.valaris/repos"' in yaml_body
    assert "/path/to/repos" not in yaml_body


async def test_export_mcp_json_has_api_key_placeholder(
    client: AsyncClient, test_user: User
):
    """The exported MCP JSON never embeds a real API key — uses ${VALARIS_API_KEY}
    so the operator fills it from env at launch."""
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    files = _read_zip(response.content)
    import json as _json
    mcp = _json.loads(files["mcp-config-standup-bot.json"])

    valaris = mcp["mcpServers"]["valaris"]
    assert valaris["env"]["VALARIS_API_KEY"] == "${VALARIS_API_KEY}"
    assert valaris["env"]["VALARIS_API_URL"]  # present, whatever the value
    # The MCP server command is `uvx backplane-mcp` — the README's documented
    # install, resolved from PyPI. No repo-local path for the operator to fill in.
    assert valaris["command"] == "uvx"
    assert valaris["args"] == ["backplane-mcp"]


async def test_export_endpoint_uses_settings_api_url(
    client: AsyncClient, test_user: User, monkeypatch
):
    """B13: the exported bundle's api_url comes from settings.API_URL so operators
    never hand-edit `https://your-backend-url.run.app` placeholders."""
    from app.config import settings

    monkeypatch.setattr(settings, "API_URL", "https://override.valaris.example.com")

    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    assert response.status_code == 200
    files = _read_zip(response.content)

    yaml_body = files["runner-standup-bot.yaml"]
    assert 'api_url: "https://override.valaris.example.com"' in yaml_body
    assert "https://your-backend-url.run.app" not in yaml_body

    import json as _json
    mcp = _json.loads(files["mcp-config-standup-bot.json"])
    assert (
        mcp["mcpServers"]["valaris"]["env"]["VALARIS_API_URL"]
        == "https://override.valaris.example.com"
    )


async def test_export_bundle_includes_readme_with_runner_download_url(
    client: AsyncClient, test_user: User
):
    """The bundle travels to machines without the runner binary — README.txt
    must say where to download it (latest/ alias, never a pinned version)."""
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    files = _read_zip(response.content)

    assert "README.txt" in files
    readme = files["README.txt"]
    assert "backplane-artifacts/runner/latest" in readme
    assert "SHA256SUMS" in readme
    assert "runner-standup-bot.yaml" in readme
    assert "-doctor" in readme


async def test_export_readme_docs_link_uses_frontend_url(
    client: AsyncClient, test_user: User, monkeypatch
):
    """/documentation is a frontend route — the README's docs pointer must come
    from FRONTEND_URL, not API_URL (prod's API host is the bare Cloud Run URL,
    which serves no docs)."""
    from app.config import settings

    monkeypatch.setattr(settings, "API_URL", "https://api.valaris.example.com")
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://app.valaris.example.com")
    create_resp = await client.post(
        BASE_URL,
        json={**VALID_AGENT, "allowed_workspaces": ["my-workspace"]},
    )
    agent_id = create_resp.json()["id"]

    response = await client.get(f"{BASE_URL}/{agent_id}/export-config")
    files = _read_zip(response.content)

    readme = files["README.txt"]
    assert "Full documentation: https://app.valaris.example.com/documentation" in readme
    assert "https://api.valaris.example.com/documentation" not in readme
