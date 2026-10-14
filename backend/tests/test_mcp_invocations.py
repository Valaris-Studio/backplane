# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

import pytest
from sqlalchemy import delete, func, select

from app.models.activity import Activity
from app.models.workspace import WorkspaceMember


def outcome(**values):
    return {
        "id": str(uuid.uuid4()),
        "tool_name": "create_note",
        "workspace_slug": "default",
        "arguments_summary": "{}",
        "result_summary": "saved",
        "status": "completed",
        "error_message": None,
        "started_at": "2026-09-24T02:00:00Z",
        "completed_at": "2026-09-24T02:00:01Z",
        "duration_seconds": 1.0,
        **values,
    }


async def test_invocation_is_canonical_private_and_idempotent(
    client, db_session, test_workspace
):
    body = outcome()
    first = await client.post("/api/me/mcp-invocations", json=body)
    assert first.status_code == 200
    second = await client.post("/api/me/mcp-invocations", json=body)
    assert second.json() == first.json()
    assert first.json()["workspace_id"] == str(test_workspace.id)
    assert first.json()["scope_status"] == "authorized"
    assert first.headers["cache-control"] == "no-store"
    assert (
        await client.post("/api/me/mcp-invocations", json={**body, "status": "failed"})
    ).status_code == 409
    from app.models.mcp_invocation import MCPInvocation

    assert await db_session.scalar(select(func.count()).select_from(MCPInvocation)) == 1
    assert await db_session.scalar(select(func.count()).select_from(Activity)) == 0


async def test_hidden_id_conflict_does_not_expose_or_overwrite_owner(
    client, db_session, test_workspace, second_user
):
    from app.schemas.mcp_invocation import MCPInvocationCreate
    from app.services.mcp_invocation import MCPInvocationService
    from app.exceptions import ResourceNotFoundError
    import pytest

    body = outcome(workspace_slug=None)
    row = (await client.post("/api/me/mcp-invocations", json=body)).json()
    service = MCPInvocationService(db_session)
    with pytest.raises(ResourceNotFoundError):
        await service.record(second_user.id, MCPInvocationCreate(**body))
    with pytest.raises(ResourceNotFoundError):
        await service.get(second_user.id, uuid.UUID(row["id"]))
    assert (await client.get("/api/me/mcp-invocations/" + row["id"])).json() == row


async def test_membership_is_rechecked_on_read_and_retry(
    client, db_session, test_workspace, test_user
):
    body = outcome()
    assert (await client.post("/api/me/mcp-invocations", json=body)).status_code == 200
    await db_session.execute(
        delete(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    assert (
        await client.get("/api/me/mcp-invocations/" + body["id"])
    ).status_code == 404
    assert (await client.post("/api/me/mcp-invocations", json=body)).status_code == 404


async def test_unauthorized_attempt_records_no_workspace_link(client, test_workspace):
    body = outcome(workspace_slug="unavailable-workspace", status="failed")
    response = await client.post("/api/me/mcp-invocations", json=body)
    assert response.status_code == 200
    assert response.json()["workspace_id"] is None
    assert response.json()["scope_status"] == "unavailable"


async def test_global_tools_and_viewer_reads_can_be_recorded(
    client, db_session, test_workspace, test_user
):
    member = await db_session.scalar(
        select(WorkspaceMember).where(WorkspaceMember.user_id == test_user.id)
    )
    from app.models.workspace import WorkspaceRole

    member.role = WorkspaceRole.viewer
    for slug in [None, "default"]:
        response = await client.post(
            "/api/me/mcp-invocations", json=outcome(workspace_slug=slug)
        )
        assert response.status_code == 200


async def test_actual_mutation_has_one_activity_with_correlation(
    client, db_session, test_workspace
):
    invocation_id = str(uuid.uuid4())
    response = await client.post(
        "/api/workspaces/default/notes",
        json={"title": "Synthetic", "content": "{}"},
        headers={"X-Backplane-Invocation-ID": invocation_id},
    )
    assert response.status_code == 201
    activities = list(await db_session.scalars(select(Activity)))
    assert len(activities) == 1
    assert str(activities[0].mcp_invocation_id) == invocation_id
    assert (
        await client.post("/api/me/mcp-invocations", json=outcome(id=invocation_id))
    ).status_code == 200
    assert await db_session.scalar(select(func.count()).select_from(Activity)) == 1
    await client.post(
        "/api/workspaces/default/notes", json={"title": "Uncorrelated", "content": "{}"}
    )
    rows = list(
        await db_session.scalars(select(Activity).order_by(Activity.created_at))
    )
    assert rows[-1].mcp_invocation_id is None


async def test_correlation_header_does_not_authorize_workspace(client, test_workspace):
    response = await client.post(
        "/api/workspaces/missing/notes",
        json={"title": "Synthetic"},
        headers={"X-Backplane-Invocation-ID": str(uuid.uuid4())},
    )
    assert response.status_code == 404


async def test_service_revalidates_payload_and_does_not_commit_caller(
    client, db_session, test_workspace, test_user
):
    import pytest
    from app.exceptions import ValidationError
    from app.schemas.mcp_invocation import MCPInvocationCreate
    from app.services.mcp_invocation import MCPInvocationService

    service = MCPInvocationService(db_session)
    with pytest.raises(ValidationError):
        await service.record(
            test_user.id,
            MCPInvocationCreate.model_construct(**outcome(duration_seconds=-1)),
        )
    await service.record(test_user.id, MCPInvocationCreate(**outcome()))
    assert db_session.in_transaction()


async def test_agent_principal_cannot_read_human_record_or_cross_scope(
    client, db_session, test_workspace, test_user
):
    import pytest
    from app.core.auth import current_agent_id
    from app.exceptions import ResourceNotFoundError
    from app.models.agents.agent import Agent, AgentType
    from app.schemas.mcp_invocation import MCPInvocationCreate
    from app.services.mcp_invocation import MCPInvocationService

    body = outcome()
    assert (await client.post("/api/me/mcp-invocations", json=body)).status_code == 200
    agent = Agent(
        name="Synthetic arbitrary role",
        agent_type=AgentType.coding,
        created_by_id=test_user.id,
        allowed_workspaces=["elsewhere"],
    )
    db_session.add(agent)
    await db_session.flush()
    token = current_agent_id.set(agent.id)
    try:
        service = MCPInvocationService(db_session)
        with pytest.raises(ResourceNotFoundError):
            await service.get(test_user.id, uuid.UUID(body["id"]))
        with pytest.raises(ResourceNotFoundError):
            await service.record(test_user.id, MCPInvocationCreate(**body))
        own = await service.record(
            test_user.id, MCPInvocationCreate(**outcome(status="failed"))
        )
        assert own.workspace_id is None and own.scope_status == "unavailable"
        agent.allowed_workspaces = ["default"]
        await db_session.flush()
        allowed = await service.record(test_user.id, MCPInvocationCreate(**outcome()))
        assert allowed.workspace_id == test_workspace.id
        agent.allowed_workspaces = ["elsewhere"]
        await db_session.flush()
        with pytest.raises(ResourceNotFoundError):
            await service.get(test_user.id, allowed.id)
    finally:
        current_agent_id.reset(token)


async def test_no_client_activity_or_owner_fields_are_accepted(client, test_workspace):
    for extra in [
        {"owner_id": str(uuid.uuid4())},
        {"activity_ids": [str(uuid.uuid4())]},
        {"agent_id": str(uuid.uuid4())},
    ]:
        response = await client.post(
            "/api/me/mcp-invocations", json={**outcome(), **extra}
        )
        assert response.status_code == 422


async def test_malformed_correlation_does_not_break_ordinary_mutation(
    client, db_session, test_workspace
):
    response = await client.post(
        "/api/workspaces/default/notes",
        json={"title": "Synthetic", "content": "{}"},
        headers={"X-Backplane-Invocation-ID": "invalid"},
    )
    assert response.status_code == 201
    assert (await db_session.scalar(select(Activity))).mcp_invocation_id is None


async def test_invocation_endpoint_openapi_is_internal_and_does_not_accept_owner(
    client,
):
    schema = (await client.get("/api/openapi.json")).json()
    operation = schema["paths"]["/api/me/mcp-invocations"]["post"]
    assert operation["x-surface"] == "internal"
    assert (
        "owner_id"
        not in schema["components"]["schemas"]["MCPInvocationCreate"]["properties"]
    )


async def test_generic_native_context_is_stored_returned_and_part_of_retry_identity(
    client, test_workspace
):
    body = outcome(
        harness="some_future_agent",
        native_call_id="call_7Hq2:abc",
        client_name="Synthetic Client",
        client_version="1.2.3",
        server_instance_id="server-instance-1",
    )
    first = await client.post("/api/me/mcp-invocations", json=body)
    assert first.status_code == 200, first.text
    for field in [
        "harness",
        "native_call_id",
        "client_name",
        "client_version",
        "server_instance_id",
    ]:
        assert first.json()[field] == body[field]
    assert (await client.post("/api/me/mcp-invocations", json=body)).json() == (
        first.json()
    )
    changed = {**body, "native_call_id": "call_other"}
    assert (
        await client.post("/api/me/mcp-invocations", json=changed)
    ).status_code == 409


@pytest.mark.parametrize(
    "extra",
    [
        {"harness": "Claude Code"},
        {"harness": "x"},
        {"native_call_id": "has space"},
        {"native_context": {"bridge": "claude_result_v3"}},
    ],
)
async def test_malformed_native_context_is_rejected(client, test_workspace, extra):
    response = await client.post("/api/me/mcp-invocations", json=outcome(**extra))
    assert response.status_code == 422
