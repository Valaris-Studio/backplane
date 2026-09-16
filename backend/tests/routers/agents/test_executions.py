# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.agent import Agent, AgentType
from app.models.user import User
from app.models.workspace import Workspace


AGENTS_URL = "/api/agents"

VALID_AGENT = {
    "name": "tdd-coder",
    "agent_type": "coding",
    "description": "TDD coding agent",
    "allowed_workspaces": ["default"],
}


async def _create_agent(client: AsyncClient) -> dict:
    resp = await client.post(AGENTS_URL, json=VALID_AGENT)
    return resp.json()


async def test_start_execution(client: AsyncClient, test_user: User, test_workspace: Workspace):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "tdd_implement",
            "input_summary": "Implement rate limiting middleware",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["agent_id"] == agent_id
    assert data["action"] == "tdd_implement"
    assert data["status"] == "started"
    assert data["input_summary"] == "Implement rate limiting middleware"
    assert "id" in data
    assert "started_at" in data


async def test_start_execution_with_board(
    client: AsyncClient, test_user: User, test_workspace: Workspace, test_board
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "board_id": str(test_board.id),
            "action": "standup",
            "input_summary": "Generate daily standup",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["board_id"] == str(test_board.id)


async def test_start_execution_agent_not_found(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    fake_id = uuid.uuid4()
    response = await client.post(
        f"{AGENTS_URL}/{fake_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "test",
            "input_summary": "test",
        },
    )
    assert response.status_code == 404


async def test_update_execution_complete(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Build feature X",
        },
    )
    exec_id = start_resp.json()["id"]

    response = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "status": "completed",
            "output_summary": "Implemented feature X with 3 tests",
            "tools_used": ["create_card", "update_card", "move_card"],
            "cards_affected": [str(uuid.uuid4())],
            "tool_calls_count": 12,
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    assert data["output_summary"] == "Implemented feature X with 3 tests"
    assert data["tools_used"] == ["create_card", "update_card", "move_card"]
    assert data["tool_calls_count"] == 12
    assert data["completed_at"] is not None


async def test_update_execution_failed(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Build feature Y",
        },
    )
    exec_id = start_resp.json()["id"]

    response = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "status": "failed",
            "error_message": "Test suite failed: 3 tests broken",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "failed"
    assert data["error_message"] == "Test suite failed: 3 tests broken"


async def test_update_execution_skipped(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    # `skipped` is the terminal status runner uses when a custom pipeline
    # stage has no cached prompt template — graceful-skip, not a failure.
    # The frontend surfaces these to the user as "this stage needs a prompt",
    # so the status must persist (not 422) and completed_at must be set
    # so the card moves past the execution on the UI.
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "triage",
            "input_summary": "Custom stage with no cached prompt",
        },
    )
    exec_id = start_resp.json()["id"]

    response = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "status": "skipped",
            "output_summary": "no prompt template cached for stage",
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "skipped"
    assert data["output_summary"] == "no prompt template cached for stage"
    assert data["completed_at"] is not None


async def test_list_executions(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={"workspace_slug": "default", "action": "task_1", "input_summary": "First"},
    )
    await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={"workspace_slug": "default", "action": "task_2", "input_summary": "Second"},
    )

    response = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2


async def test_list_executions_agent_not_found(client: AsyncClient, test_user: User):
    fake_id = uuid.uuid4()
    response = await client.get(f"{AGENTS_URL}/{fake_id}/executions")
    assert response.status_code == 404


async def test_start_execution_with_parent_id(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    parent_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "First attempt",
        },
    )
    parent_id = parent_resp.json()["id"]

    child_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Retry after failure",
            "parent_execution_id": parent_id,
        },
    )
    assert child_resp.status_code == 201
    data = child_resp.json()
    assert data["parent_execution_id"] == parent_id


async def test_start_execution_without_parent_id(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "standup",
            "input_summary": "Daily standup",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["parent_execution_id"] is None


async def test_execution_read_includes_parent_id(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "review",
            "input_summary": "Review PR",
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert "parent_execution_id" in data

    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert list_resp.status_code == 200
    executions = list_resp.json()
    assert all("parent_execution_id" in e for e in executions)


async def test_log_execution_start_with_role(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "orchestrate",
            "input_summary": "Coordinate sprint work",
            "role": "orchestrator",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["role"] == "orchestrator"


async def test_log_execution_start_without_role(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "standup",
            "input_summary": "Daily standup",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["role"] is None


async def test_list_executions_filter_by_role(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Build feature",
            "role": "implementer",
        },
    )
    await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "review",
            "input_summary": "Review code",
            "role": "reviewer",
        },
    )
    await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "standup",
            "input_summary": "Daily standup",
        },
    )

    all_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert len(all_resp.json()) == 3

    filtered_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions?role=reviewer")
    assert filtered_resp.status_code == 200
    filtered = filtered_resp.json()
    assert len(filtered) == 1
    assert filtered[0]["role"] == "reviewer"


async def test_execution_read_includes_role(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "review",
            "input_summary": "Review PR",
            "role": "reviewer",
        },
    )
    assert resp.status_code == 201
    data = resp.json()
    assert "role" in data
    assert data["role"] == "reviewer"

    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert list_resp.status_code == 200
    executions = list_resp.json()
    assert all("role" in e for e in executions)


async def test_create_execution_with_input_prompt(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Build auth middleware",
            "input_prompt": "You are a coding agent. Implement JWT auth middleware for FastAPI.",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["input_prompt"] == "You are a coding agent. Implement JWT auth middleware for FastAPI."


async def test_update_execution_with_input_prompt(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement",
            "input_summary": "Build feature Z",
        },
    )
    assert start_resp.status_code == 201
    exec_id = start_resp.json()["id"]
    assert start_resp.json()["input_prompt"] is None

    update_resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "input_prompt": "You are a coding agent. Build feature Z with full test coverage.",
        },
    )
    assert update_resp.status_code == 200
    data = update_resp.json()
    assert data["input_prompt"] == "You are a coding agent. Build feature Z with full test coverage."


async def test_create_execution_without_input_prompt(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "standup",
            "input_summary": "Daily standup",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert data["input_prompt"] is None


async def test_start_execution_non_owner_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    other_agent = Agent(
        name="someone-elses-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    response = await client.post(
        f"{AGENTS_URL}/{other_agent.id}/executions",
        json={
            "workspace_slug": "default",
            "action": "spoof",
            "input_summary": "Spoofed execution",
        },
    )
    assert response.status_code == 404


async def test_update_execution_non_owner_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    other_agent = Agent(
        name="other-owners-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    from app.models.agents.execution import AgentExecution, ExecutionStatus

    execution = AgentExecution(
        agent_id=other_agent.id,
        workspace_id=test_workspace.id,
        action="private",
        status=ExecutionStatus.started,
        input_summary="Private execution",
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.patch(
        f"{AGENTS_URL}/{other_agent.id}/executions/{execution.id}",
        json={"cost_usd": 999.0, "status": "completed"},
    )
    assert response.status_code == 404


async def test_execution_ship_warnings_defaults_empty_or_null(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    # Fresh executions have no ship_warnings — the field is nullable on the
    # model. ExecutionRead must still expose the key (defaulted to []) so the
    # frontend can render unconditionally without optional-chaining gymnastics.
    agent = await _create_agent(client)
    agent_id = agent["id"]

    response = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "ship",
            "input_summary": "Ship feature",
        },
    )
    assert response.status_code == 201
    data = response.json()
    assert "ship_warnings" in data
    assert data["ship_warnings"] in (None, [])


async def test_log_execution_update_accepts_ship_warnings_and_persists(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    # B16: when the ship stage detects a non-fatal problem (e.g. auto-merge
    # arming failed because branch protection is missing), the runner must
    # be able to ship the warnings with the completion update so the UI can
    # surface them — the WARN log alone never reaches platform telemetry.
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "ship",
            "input_summary": "Ship with non-fatal issues",
        },
    )
    exec_id = start_resp.json()["id"]

    response = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={
            "status": "completed",
            "output_summary": "Shipped with warnings",
            "ship_warnings": [
                "auto-merge arming failed: Protected branch rules not configured for this branch",
            ],
        },
    )
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "completed"
    assert data["ship_warnings"] == [
        "auto-merge arming failed: Protected branch rules not configured for this branch",
    ]


async def test_execution_read_exposes_ship_warnings(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "ship",
            "input_summary": "Ship pass",
        },
    )
    exec_id = start_resp.json()["id"]

    warnings = ["auto-merge arming failed: foo", "label not applied: bar"]
    await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={"status": "completed", "ship_warnings": warnings},
    )

    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert list_resp.status_code == 200
    executions = list_resp.json()
    assert all("ship_warnings" in e for e in executions)
    shipped = next(e for e in executions if e["id"] == exec_id)
    assert shipped["ship_warnings"] == warnings


async def test_list_executions_non_owner_rejected(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
):
    other_agent = Agent(
        name="private-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    response = await client.get(f"{AGENTS_URL}/{other_agent.id}/executions")
    assert response.status_code == 404


# Hostile-tenant guard tests for /api/agents/{agent_id}/executions.
# ExecutionService._get_agent raises ResourceNotFoundError (404, not 403) when
# the requesting user is not the agent's owner — same shape as a missing agent,
# so callers can't probe for existence by tenant. These tests pin that
# behavior across all three mutation endpoints (start, update, record tools).
async def test_start_execution_other_user_agent_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    other_agent = Agent(
        name="user-b-agent",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    response = await client.post(
        f"{AGENTS_URL}/{other_agent.id}/executions",
        json={
            "workspace_slug": "default",
            "action": "hostile_start",
            "input_summary": "Should be denied",
        },
    )
    assert response.status_code == 404


async def test_update_execution_other_user_agent_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    other_agent = Agent(
        name="user-b-agent-update",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    from app.models.agents.execution import AgentExecution, ExecutionStatus

    execution = AgentExecution(
        agent_id=other_agent.id,
        workspace_id=test_workspace.id,
        action="owned_by_user_b",
        status=ExecutionStatus.started,
        input_summary="User B's private execution",
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.patch(
        f"{AGENTS_URL}/{other_agent.id}/executions/{execution.id}",
        json={"status": "completed", "output_summary": "hijacked"},
    )
    assert response.status_code == 404


async def test_record_tool_invocations_other_user_agent_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    other_agent = Agent(
        name="user-b-agent-tools",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    from app.models.agents.execution import AgentExecution, ExecutionStatus

    execution = AgentExecution(
        agent_id=other_agent.id,
        workspace_id=test_workspace.id,
        action="owned_by_user_b",
        status=ExecutionStatus.started,
        input_summary="User B's private execution",
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.post(
        f"{AGENTS_URL}/{other_agent.id}/executions/{execution.id}/tool-invocations",
        json=[
            {
                "tool_name": "create_card",
                "status": "success",
            }
        ],
    )
    assert response.status_code == 404


# Card 5a33c510 — silent approval-polling deadline retries.
# The Go runner POSTs to this endpoint when an approval-poll deadline trips.
# The endpoint must:
#   1. Append the warning to the execution row's ship_warnings (post-mortem).
#   2. Publish an `execution.warning` WebSocket event (live HealthCard signal).
# Retry behavior is unchanged — this is purely an observability surface.
async def test_post_execution_warning_appends_to_ship_warnings(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement_card",
            "input_summary": "Implementation pending human approval",
        },
    )
    exec_id = start_resp.json()["id"]

    warn_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}/warnings",
        json={
            "kind": "approval_poll_deadline",
            "message": "approval approval-stuck still pending after 5m0s; retrying",
            "card_id": "11111111-1111-1111-1111-111111111111",
        },
    )
    assert warn_resp.status_code == 202

    # GET the execution and verify ship_warnings carries the typed warning.
    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    assert list_resp.status_code == 200
    execution = next(e for e in list_resp.json() if e["id"] == exec_id)
    assert execution["ship_warnings"], "ship_warnings must be populated after warning POST"
    assert any(
        "approval_poll_deadline" in w for w in execution["ship_warnings"]
    ), f"warning kind missing from ship_warnings: {execution['ship_warnings']}"


async def test_post_execution_warning_publishes_execution_warning_event(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    from app.core import events
    from app.core.event_bus import event_bus

    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": "implement_card",
            "input_summary": "Stuck waiting on human",
        },
    )
    exec_id = start_resp.json()["id"]

    received: list = []

    async def capture(event):
        received.append(event)

    unsub = event_bus.subscribe(
        capture,
        workspace_id=test_workspace.id,
        event_pattern=events.EXECUTION_WARNING,
    )

    try:
        warn_resp = await client.post(
            f"{AGENTS_URL}/{agent_id}/executions/{exec_id}/warnings",
            json={
                "kind": "approval_poll_deadline",
                "message": "approval approval-stuck still pending after 5m0s; retrying",
                "card_id": "22222222-2222-2222-2222-222222222222",
            },
        )
    finally:
        unsub()

    assert warn_resp.status_code == 202
    assert len(received) == 1, f"expected exactly one execution.warning event, got {len(received)}"

    event = received[0]
    assert event.event_type == events.EXECUTION_WARNING
    payload = event.payload
    assert payload["kind"] == "approval_poll_deadline"
    assert payload["execution_id"] == exec_id
    assert payload["agent_id"] == agent_id
    assert payload["card_id"] == "22222222-2222-2222-2222-222222222222"
    assert "still pending" in payload["message"]


async def test_post_execution_warning_other_user_agent_returns_404(
    client: AsyncClient,
    db_session: AsyncSession,
    second_user: User,
    test_workspace: Workspace,
):
    # Hostile-tenant guard: a user must not be able to post warnings against
    # another user's agent — same 404-not-403 shape as the other execution
    # mutation endpoints so existence isn't probeable across tenants.
    other_agent = Agent(
        name="user-b-agent-warnings",
        agent_type=AgentType.coding,
        created_by_id=second_user.id,
    )
    db_session.add(other_agent)
    await db_session.flush()

    from app.models.agents.execution import AgentExecution, ExecutionStatus

    execution = AgentExecution(
        agent_id=other_agent.id,
        workspace_id=test_workspace.id,
        action="owned_by_user_b",
        status=ExecutionStatus.started,
        input_summary="Private",
    )
    db_session.add(execution)
    await db_session.flush()

    response = await client.post(
        f"{AGENTS_URL}/{other_agent.id}/executions/{execution.id}/warnings",
        json={
            "kind": "approval_poll_deadline",
            "message": "hostile",
        },
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Telemetry honesty + fat-finger resilience (run-B B3 incident, 2026-06-09).
# An LLM stage free-types its execution_id into log_execution_update: a one
# digit typo used to 404 and the model flailed; a confused model could also
# flip a stage that actually COMPLETED to status='failed'.
# ---------------------------------------------------------------------------


async def _start_execution(client: AsyncClient, agent_id: str, action: str = "plan") -> str:
    resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "action": action,
            "input_summary": f"run {action}",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def test_update_execution_completed_is_sticky_against_failed(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    """A completed execution must not be downgraded to failed by a late,
    confused model retry — the stage DID complete; keep telemetry honest."""
    agent = await _create_agent(client)
    agent_id = agent["id"]
    exec_id = await _start_execution(client, agent_id)

    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={"status": "completed", "output_summary": "planned fine"},
    )
    assert resp.status_code == 200

    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={"status": "failed", "error_message": "model got confused mid-flail"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"

    # Re-read: the row itself stayed completed (2xx != persisted).
    listing = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    row = next(e for e in listing.json() if e["id"] == exec_id)
    assert row["status"] == "completed"
    # The confused report is still recorded for forensics.
    assert row["error_message"] == "model got confused mid-flail"


async def test_update_execution_failed_heals_to_completed(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    """The reverse transition stays allowed: a model that wrongly self-failed
    is healed when the runner's authoritative stage-end close reports
    completed (the B3 shape)."""
    agent = await _create_agent(client)
    agent_id = agent["id"]
    exec_id = await _start_execution(client, agent_id)

    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={"status": "failed", "error_message": "board 404 (typo'd UUID)"},
    )
    assert resp.status_code == 200

    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={"status": "completed", "output_summary": "plan note written"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "completed"


async def test_update_execution_unknown_id_falls_back_to_single_inflight(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    """A fat-fingered execution_id with exactly ONE in-flight execution for
    the agent is unambiguous — apply the update there instead of 404ing the
    model into a flail loop."""
    agent = await _create_agent(client)
    agent_id = agent["id"]
    exec_id = await _start_execution(client, agent_id)

    typo_id = str(uuid.uuid4())
    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{typo_id}",
        json={"status": "completed", "output_summary": "done despite typo"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["id"] == exec_id
    assert resp.json()["status"] == "completed"


async def test_update_execution_unknown_id_with_multiple_inflight_404s(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    """Two in-flight executions = ambiguous — never guess, keep the 404."""
    agent = await _create_agent(client)
    agent_id = agent["id"]
    await _start_execution(client, agent_id, action="plan")
    await _start_execution(client, agent_id, action="implement")

    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{uuid.uuid4()}",
        json={"status": "completed"},
    )
    assert resp.status_code == 404


async def test_update_execution_unknown_id_with_no_inflight_404s(
    client: AsyncClient, test_user: User, test_workspace: Workspace
):
    """No in-flight execution (e.g. already closed) — unknown id stays 404;
    the fallback must not resurrect terminal rows."""
    agent = await _create_agent(client)
    agent_id = agent["id"]
    exec_id = await _start_execution(client, agent_id)
    await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{exec_id}",
        json={"status": "completed"},
    )

    resp = await client.patch(
        f"{AGENTS_URL}/{agent_id}/executions/{uuid.uuid4()}",
        json={"status": "failed"},
    )
    assert resp.status_code == 404


async def test_execution_read_includes_cards_affected_detail(
    client: AsyncClient, test_user: User, test_workspace: Workspace, test_board, test_card
):
    agent = await _create_agent(client)
    agent_id = agent["id"]

    start_resp = await client.post(
        f"{AGENTS_URL}/{agent_id}/executions",
        json={
            "workspace_slug": "default",
            "board_id": str(test_board.id),
            "card_id": str(test_card.id),
            "action": "implement",
            "input_summary": "work the card",
            "role": "implementer",
        },
    )
    assert start_resp.status_code == 201
    detail = start_resp.json()["cards_affected_detail"]
    assert detail == [
        {"id": str(test_card.id), "title": test_card.title, "board_id": str(test_board.id)}
    ]

    list_resp = await client.get(f"{AGENTS_URL}/{agent_id}/executions")
    listed = next(e for e in list_resp.json() if e["id"] == start_resp.json()["id"])
    assert listed["cards_affected_detail"][0]["title"] == test_card.title
