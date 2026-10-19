# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import json
import secrets
import uuid
from contextlib import AsyncExitStack, asynccontextmanager

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, func, select

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.api_key import ApiKey
from app.models.mcp_invocation import MCPInvocation
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole

PRIVATE_OUTCOME_FIELDS = {
    "arguments_summary": "private-arguments-canary",
    "result_summary": "private-result-canary",
    "error_message": "private-error-canary",
    "harness": "private_harness_canary",
    "native_call_id": "private-native-call-canary",
    "client_name": "private-client-canary",
    "client_version": "private-version-canary",
    "server_instance_id": "private-server-canary",
    "arguments_fingerprint": "c" * 64,
}
ACTOR_FIELDS = {
    "user_id", "user_name", "authentication_method", "principal_kind",
    "agent_id", "agent_name", "api_key_id", "api_key_name", "installation_id",
}


def _outcome(invocation_id, workspace_slug, **overrides):
    return {
        "id": str(invocation_id), "workspace_slug": workspace_slug,
        "tool_name": "update_note", "status": "completed",
        "started_at": "2026-10-18T23:00:00Z",
        "completed_at": "2026-10-18T23:00:01Z", "duration_seconds": 1,
        **PRIVATE_OUTCOME_FIELDS, **overrides,
    }


@asynccontextmanager
async def _key_client(db, user, agent_name=None):
    raw_key = "vlr_" + secrets.token_urlsafe(32)
    key = ApiKey(user_id=user.id, name=agent_name or "review-personal",
                 key_hash=hashlib.sha256(raw_key.encode()).hexdigest(), key_prefix=raw_key[:8])
    db.add(key)
    await db.flush()
    if agent_name:
        db.add(Agent(name=agent_name, agent_type=AgentType.coding,
                     created_by_id=user.id, api_key_id=key.id, is_active=True,
                     allowed_workspaces=["default"]))
        await db.flush()
    app = create_app()

    async def database():
        yield db

    # Only storage is isolated; authentication and invocation context run normally.
    app.dependency_overrides[get_db] = database
    async with AsyncClient(transport=ASGITransport(app), base_url="http://test",
                           headers={"Authorization": f"Bearer {raw_key}"}) as client:
        yield client


async def _write(client, workspace, board, invocation_id, tool_name="update_note"):
    collection = f"/api/workspaces/{workspace.slug}/boards/{board.id}/notes"
    headers = {"X-Backplane-Invocation-ID": str(invocation_id),
               "X-Model": "forged-model-canary", "X-Client": "browser-session-canary"}
    created = await client.post(collection, json={"title": "Channel review", "content": "# State\n\nBefore"},
                                headers=headers if tool_name == "create_note" else {})
    assert created.status_code == 201, created.text
    note_id = created.json()["id"]
    if tool_name == "create_note":
        saved = created.json()
    else:
        suffix, payload = {
            "update_note": ("/edit", {"mode": "replace", "title": "Committed edit"}),
            "append_note": ("/append", {"content": "Committed append"}),
            "replace_note_section": ("/replace-section", {"anchor_heading": "State", "content": "Committed section"}),
        }[tool_name]
        edited = await client.post(f"{collection}/{note_id}{suffix}", json=payload, headers=headers)
        assert edited.status_code == 200, edited.text
        saved = edited.json()
    return f"/api/workspaces/{workspace.slug}/notes/{note_id}", saved


async def _history_views(client, url, revision):
    responses = [
        await client.get(url + "/revisions"),
        await client.get(f"{url}/revisions/{revision}"),
        await client.get(url + "/revisions/compare", params={"from_revision": revision, "to_revision": revision}),
    ]
    for response in responses:
        assert response.status_code == 200, response.text
        cache = response.headers.get("cache-control", "")
        assert "private" in cache and "no-store" in cache
    page, detail, comparison = [response.json() for response in responses]
    assert page["latest_recorded_revision"] == revision
    assert [item["revision"] for item in page["items"]] == list(range(revision, 0, -1))
    assert comparison["changed_fields"] == []
    return [page["items"][0], detail, comparison["before"], comparison["after"]]


def _assert_safe_channel(views, expected, owner_id):
    for view in views:
        assert view["channel"] == expected
        assert view["actor"]["user_id"] == str(owner_id)
        assert view["actor"]["authentication_method"] == "api_key"
        assert set(view["actor"]) == ACTOR_FIELDS
        assert view["source_execution_id"] is None
        serialized = json.dumps(view)
        for field, value in PRIVATE_OUTCOME_FIELDS.items():
            assert field not in view and field not in view["actor"]
            assert value not in serialized
        for field in ("model", "invocation_id", "payload_hash", "key_hash", "key_prefix", "status"):
            assert field not in view and field not in view["actor"]
        assert "forged-model-canary" not in serialized
        assert "browser-session-canary" not in serialized


@pytest.mark.parametrize("tool_name,status", [
    ("create_note", "completed"), ("update_note", "completed"),
    ("update_note", "failed"), ("update_note", "aborted"),
    ("append_note", "completed"), ("replace_note_section", "completed"),
])
async def test_matching_late_outcome_qualifies_channel_without_attesting_success_or_leaking_context(
    tool_name, status, plain_key_client, db_engine, test_workspace, test_board, test_user,
):
    invocation_id = uuid.uuid4()
    url, saved = await _write(plain_key_client, test_workspace, test_board, invocation_id, tool_name)
    revision = saved["history_revision"]
    before = await _history_views(plain_key_client, url, revision)
    _assert_safe_channel(before, "unconfirmed", test_user.id)
    recorded = await plain_key_client.post("/api/me/mcp-invocations", json=_outcome(
        invocation_id, test_workspace.slug, tool_name=tool_name, status=status,
    ))
    assert recorded.status_code == 200, recorded.text
    assert recorded.json()["scope_status"] == "authorized"
    assert recorded.json()["owner_id"] == str(test_user.id)
    assert recorded.json()["status"] == status
    statements = []

    def observe(_connection, _cursor, statement, _parameters, _context, _many):
        if statement.lstrip().lower().startswith("select") and "mcp_invocations" in statement.lower():
            statements.append(statement.lower())

    event.listen(db_engine.sync_engine, "before_cursor_execute", observe)
    try:
        after = await _history_views(plain_key_client, url, revision)
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", observe)
    _assert_safe_channel(after, "mcp_reported", test_user.id)
    assert after == [{**view, "channel": "mcp_reported"} for view in before]
    assert after[1]["snapshot"]["content"] == saved["content"]
    assert statements
    for statement in statements:
        for field in (*PRIVATE_OUTCOME_FIELDS, "payload_hash"):
            assert f"mcp_invocations.{field}" not in statement


@pytest.mark.parametrize("mismatch", ["workspace", "unavailable_scope", "unscoped", "tool"])
async def test_nonmatching_outcome_does_not_upgrade_history_channel(
    mismatch, plain_key_client, db_session, test_workspace, test_board, test_user,
):
    invocation_id = uuid.uuid4()
    url, saved = await _write(plain_key_client, test_workspace, test_board, invocation_id)
    before = await _history_views(plain_key_client, url, saved["history_revision"])
    _assert_safe_channel(before, "unconfirmed", test_user.id)
    body = _outcome(invocation_id, test_workspace.slug)
    expected_scope = "authorized"
    if mismatch == "workspace":
        other = Workspace(name="Other authorized workspace", slug="other-channel", created_by=test_user.id)
        db_session.add(other)
        await db_session.flush()
        db_session.add(WorkspaceMember(workspace_id=other.id, user_id=test_user.id, role=WorkspaceRole.owner))
        await db_session.flush()
        body["workspace_slug"] = other.slug
    elif mismatch == "unavailable_scope":
        body["workspace_slug"] = "missing-channel-workspace"
        expected_scope = "unavailable"
    elif mismatch == "unscoped":
        body["workspace_slug"] = None
        expected_scope = "unscoped"
    else:
        body["tool_name"] = "get_note"
    recorded = await plain_key_client.post("/api/me/mcp-invocations", json=body)
    assert recorded.status_code == 200, recorded.text
    assert recorded.json()["scope_status"] == expected_scope
    after = await _history_views(plain_key_client, url, saved["history_revision"])
    _assert_safe_channel(after, "unconfirmed", test_user.id)
    assert after == before


async def test_other_authorized_owner_cannot_claim_revision_with_same_correlation_id(
    plain_key_client, db_session, test_workspace, test_board, test_user, second_user,
):
    invocation_id = uuid.uuid4()
    url, saved = await _write(plain_key_client, test_workspace, test_board, invocation_id)
    db_session.add(WorkspaceMember(workspace_id=test_workspace.id, user_id=second_user.id, role=WorkspaceRole.member))
    await db_session.flush()
    async with _key_client(db_session, second_user) as other:
        recorded = await other.post("/api/me/mcp-invocations", json=_outcome(invocation_id, test_workspace.slug))
        assert recorded.status_code == 200, recorded.text
        assert recorded.json()["owner_id"] == str(second_user.id)
        assert recorded.json()["scope_status"] == "authorized"
    views = await _history_views(plain_key_client, url, saved["history_revision"])
    _assert_safe_channel(views, "unconfirmed", test_user.id)


@pytest.mark.parametrize("author,outcome_author,channel", [
    ("human", "agent-a", "unconfirmed"), ("agent-a", "human", "unconfirmed"),
    ("agent-a", "agent-b", "unconfirmed"), ("agent-a", "agent-a", "mcp_reported"),
])
async def test_registered_agent_identity_must_match_the_revision_actor(
    author, outcome_author, channel, plain_key_client, db_session, test_workspace, test_board, test_user,
):
    async with AsyncExitStack() as stack:
        clients = {"human": plain_key_client}
        for name in ("agent-a", "agent-b"):
            clients[name] = await stack.enter_async_context(_key_client(db_session, test_user, name))
        invocation_id = uuid.uuid4()
        url, saved = await _write(clients[author], test_workspace, test_board, invocation_id)
        before = await _history_views(plain_key_client, url, saved["history_revision"])
        _assert_safe_channel(before, "unconfirmed", test_user.id)
        recorded = await clients[outcome_author].post("/api/me/mcp-invocations", json=_outcome(invocation_id, test_workspace.slug))
        assert recorded.status_code == 200, recorded.text
        assert recorded.json()["scope_status"] == "authorized"
        after = await _history_views(plain_key_client, url, saved["history_revision"])
        _assert_safe_channel(after, channel, test_user.id)
        assert after == [{**view, "channel": channel} for view in before]
        actor = after[0]["actor"]
        assert actor["principal_kind"] == ("user" if author == "human" else "agent")
        assert (actor["agent_id"] is None) == (author == "human")
        assert (actor["agent_id"] == recorded.json()["agent_id"]) == (channel == "mcp_reported")


@pytest.mark.parametrize("status", ["running", "success"])
async def test_invalid_outcome_status_is_rejected_without_qualifying_channel(
    status, plain_key_client, db_session, test_workspace, test_board, test_user,
):
    invocation_id = uuid.uuid4()
    url, saved = await _write(plain_key_client, test_workspace, test_board, invocation_id)
    response = await plain_key_client.post("/api/me/mcp-invocations", json=_outcome(
        invocation_id, test_workspace.slug, status=status,
    ))
    assert response.status_code == 422, response.text
    assert await db_session.scalar(select(func.count()).select_from(MCPInvocation).where(
        MCPInvocation.id == invocation_id,
    )) == 0
    _assert_safe_channel(await _history_views(plain_key_client, url, saved["history_revision"]), "unconfirmed", test_user.id)


async def test_matching_outcome_does_not_restore_revoked_history_access(
    plain_key_client, db_session, test_workspace, test_board, test_user,
):
    invocation_id = uuid.uuid4()
    url, saved = await _write(plain_key_client, test_workspace, test_board, invocation_id)
    recorded = await plain_key_client.post("/api/me/mcp-invocations", json=_outcome(invocation_id, test_workspace.slug))
    assert recorded.status_code == 200, recorded.text
    _assert_safe_channel(await _history_views(plain_key_client, url, saved["history_revision"]), "mcp_reported", test_user.id)
    await db_session.execute(delete(WorkspaceMember).where(
        WorkspaceMember.workspace_id == test_workspace.id, WorkspaceMember.user_id == test_user.id,
    ))
    for suffix in ("/revisions", f"/revisions/{saved['history_revision']}", "/revisions/compare?from_revision=1&to_revision=1"):
        denied = await plain_key_client.get(url + suffix)
        assert denied.status_code == 403, denied.text
        assert "private" in denied.headers.get("cache-control", "")
        assert "no-store" in denied.headers.get("cache-control", "")
        assert "Committed edit" not in denied.text and "private-result-canary" not in denied.text
