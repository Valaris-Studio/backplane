# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Readiness uses deployed credentials and real forge HTTP, without mutations."""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from sqlalchemy import event, select

from app.config import settings
from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.kanban.completion import CompletionCandidate
from tests.test_agent_workspace_scope import (
    _make_agent_with_key,
    _make_workspace,
    raw_key_client,
)
from tests.test_postmerge_acceptance import completion_fixture, status, submit

__all__ = ["completion_fixture", "raw_key_client"]
pytestmark = pytest.mark.slow

WORKSPACE_TOKEN = "fixture-workspace-pat-do-not-display"
PLATFORM_TOKEN = "fixture-platform-pat-do-not-display"
RAW_ERROR = "fixture-private-forge-error-body-do-not-display"
REPO_PATH = "/repos/valaris/test-repo"


@pytest.fixture
async def readiness_fixture(completion_fixture, test_user, monkeypatch):
    f = completion_fixture
    monkeypatch.setattr(settings, "GITHUB_TOKEN", PLATFORM_TOKEN)
    monkeypatch.setattr(settings, "GITHUB_API_URL", "https://api.github.com")
    monkeypatch.setattr(settings, "ALLOW_GLOBAL_TOKEN_FALLBACK", True)
    connection = GitConnection(
        workspace_id=f.board.workspace_id,
        provider=GitProvider.github,
        account_login="readiness-fixture",
        account_type="user",
        encrypted_access_token=FernetTokenVault(
            settings.INTEGRATIONS_TOKEN_KEY.encode()
        ).encrypt(WORKSPACE_TOKEN),
        auth_kind="pat",
        scopes=[],  # Fine-grained PAT permissions are not disclosed as scopes.
        connected_by=test_user.id,
        last_verified_at=datetime(2026, 1, 2),
        last_error="previous independent health probe",
        scopes_confirmed=False,
    )
    f.db.add(connection)
    await f.db.flush()
    f.repo.connection_id = connection.id
    await f.db.flush()
    return SimpleNamespace(**vars(f), connection=connection)


@pytest.fixture
def forge_http(monkeypatch):
    """Intercept outbound HTTP only; FastAPI and credential resolution stay real."""
    state = SimpleNamespace(
        requests=[],
        statuses={},
        payloads={},
        timeouts=set(),
        head_sha="a" * 40,
        merged=False,
        merge_sha="b" * 40,
    )
    original_send = httpx.AsyncClient.send

    async def controlled_send(client, request, **kwargs):
        if isinstance(client._transport, httpx.ASGITransport):
            return await original_send(client, request, **kwargs)
        assert request.url.host == "api.github.com", "unexpected outbound host"
        assert request.method == "GET", "readiness must never probe forge writes"
        path = request.url.path
        state.requests.append((path, request.headers.get("Authorization")))
        if path in state.timeouts:
            raise httpx.ReadTimeout(RAW_ERROR, request=request)
        code = state.statuses.get(path, 200)
        if code != 200:
            payload = {"message": RAW_ERROR, "token": WORKSPACE_TOKEN}
        elif path == REPO_PATH:
            payload = {"full_name": "valaris/test-repo", "permissions": {"push": True}}
        elif path == f"{REPO_PATH}/pulls":
            payload = []
        elif path == f"{REPO_PATH}/pulls/17":
            payload = {
                "number": 17,
                "state": "closed" if state.merged else "open",
                "merged": state.merged,
                "merge_commit_sha": state.merge_sha if state.merged else None,
                "mergeable": True,
                "head": {"sha": state.head_sha, "ref": "feature/accepted"},
                "base": {
                    "ref": "main",
                    "repo": {"html_url": "https://github.com/valaris/test-repo"},
                },
            }
        else:
            raise AssertionError(f"unexpected forge operation: {path}")
        payload = state.payloads.get(path, payload)
        return httpx.Response(code, json=payload, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", controlled_send)
    # Preserve production error translation without waiting for retry backoff.
    monkeypatch.setattr("app.services.github_client._RETRY_BACKOFFS_S", (0, 0))
    return state


def check_for(body, operation, candidate_id=None):
    matches = [
        check
        for check in body["checks"]
        if check["operation"] == operation and check.get("candidate_id") == candidate_id
    ]
    assert len(matches) == 1, body
    return matches[0]


def assert_private(response, caplog):
    for sentinel in (WORKSPACE_TOKEN, PLATFORM_TOKEN, RAW_ERROR):
        assert sentinel not in response.text
        assert sentinel not in caplog.text


async def test_readiness_repo_metadata_success_does_not_hide_pr_permission_failure(
    client, readiness_fixture, forge_http, caplog
):
    f = readiness_fixture
    forge_http.statuses[f"{REPO_PATH}/pulls"] = 403
    writes = []
    commits = []

    def capture_sql(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().split()[0].upper() in {"INSERT", "UPDATE", "DELETE"}:
            writes.append(statement)

    engine = f.db.bind.sync_engine

    def capture_commit(session):
        commits.append(True)

    event.listen(engine, "before_cursor_execute", capture_sql)
    event.listen(f.db.sync_session, "after_commit", capture_commit)
    try:
        response = await client.get(f"{f.url}/readiness")
    finally:
        event.remove(engine, "before_cursor_execute", capture_sql)
        event.remove(f.db.sync_session, "after_commit", capture_commit)
    assert response.status_code == 200, response.text
    body = response.json()
    assert len(body["policy_hash"]) == 64
    assert body["ready"] is False
    assert check_for(body, "repository_read")["status"] == "verified"
    denied = check_for(body, "pull_requests_read")
    assert denied["required"] is True
    assert denied["status"] == "failed"
    assert denied["code"] == "forge_auth_failed"
    assert denied["repo_id"] == str(f.repo.id)
    assert denied["credential_source"] == "workspace_connection"
    assert denied["connection_id"] == str(f.connection.id)
    assert forge_http.requests
    assert {auth for _, auth in forge_http.requests} == {f"Bearer {WORKSPACE_TOKEN}"}
    assert writes == [], "GET readiness changed database state"
    assert commits == [], "readiness must not take ownership of the request transaction"
    await f.db.refresh(f.connection)
    assert f.connection.last_verified_at == datetime(2026, 1, 2)
    assert f.connection.last_error == "previous independent health probe"
    assert f.connection.scopes_confirmed is False
    assert_private(response, caplog)


@pytest.mark.parametrize("platform", [False, True], ids=["workspace-pat", "platform"])
async def test_readiness_reports_actual_credential_source_and_unproven_writes(
    client, readiness_fixture, forge_http, caplog, platform
):
    f = readiness_fixture
    if platform:
        f.repo.connection_id = None
        await f.db.flush()
        await f.db.delete(f.connection)
        await f.db.flush()
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is True
    read = check_for(body, "pull_requests_read")
    assert read["status"] == "verified"
    assert read["credential_source"] == (
        "platform" if platform else "workspace_connection"
    )
    assert read.get("connection_id") == (None if platform else str(f.connection.id))
    write = check_for(body, "forge_write")
    assert write["required"] is False
    assert write["status"] == "unverified"
    assert write["code"] == "write_unverified"
    token = PLATFORM_TOKEN if platform else WORKSPACE_TOKEN
    assert {auth for _, auth in forge_http.requests} == {f"Bearer {token}"}
    assert_private(response, caplog)


async def test_readiness_checks_exact_preserved_candidate_pr_without_mutation(
    client, agent_client, readiness_fixture, forge_http, caplog
):
    f = readiness_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        saved = await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    before = (candidate.status, candidate.is_current, candidate.updated_at)
    forge_http.statuses[f"{REPO_PATH}/pulls/17"] = 403
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is False
    assert check_for(body, "pull_requests_read")["status"] == "verified"
    exact = check_for(body, "candidate_pr_read", saved["id"])
    assert exact["required"] is True
    assert exact["status"] == "failed"
    assert exact["code"] == "forge_auth_failed"
    assert f"{REPO_PATH}/pulls/17" in {path for path, _ in forge_http.requests}
    await f.db.refresh(candidate)
    assert (candidate.status, candidate.is_current, candidate.updated_at) == before
    assert_private(response, caplog)


async def test_readiness_timeout_is_required_unverified_not_success(
    client, readiness_fixture, forge_http, caplog
):
    f = readiness_fixture
    forge_http.timeouts.add(f"{REPO_PATH}/pulls")
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is False
    unavailable = check_for(body, "pull_requests_read")
    assert unavailable["required"] is True
    assert unavailable["status"] == "unverified"
    assert unavailable["code"] in {"forge_unavailable", "readiness_timeout"}
    assert_private(response, caplog)


async def test_readiness_workspace_scope_rejected_before_any_forge_request(
    raw_key_client, readiness_fixture, test_user, forge_http
):
    f = readiness_fixture
    raw = await _make_agent_with_key(f.db, test_user, allowed_workspaces=["elsewhere"])
    response = await raw_key_client.get(
        f"{f.url}/readiness", headers={"Authorization": f"Bearer {raw}"}
    )
    assert response.status_code == 403, response.text
    assert forge_http.requests == []


async def test_readiness_board_cannot_be_read_through_another_workspace(
    client, readiness_fixture, test_user, forge_http
):
    f = readiness_fixture
    await _make_workspace(f.db, test_user, name="Other", slug="other")
    response = await client.get(
        f"/api/workspaces/other/boards/{f.board.id}/completion/readiness"
    )
    assert response.status_code == 404, response.text
    assert forge_http.requests == []


async def test_readiness_evidence_policy_still_requires_repository_binding(
    client, readiness_fixture, forge_http
):
    f = readiness_fixture
    assert f.board.completion_policy["evidence_only"]["enabled"] is True
    await f.db.delete(f.repo)
    await f.db.flush()
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is False
    binding = check_for(body, "repository_binding")
    assert binding["required"] is True
    assert binding["status"] == "failed"
    assert binding["code"] == "repository_required"
    assert forge_http.requests == []


async def test_readiness_foreign_explicit_connection_never_falls_back_to_platform(
    client, readiness_fixture, test_user, forge_http
):
    f = readiness_fixture
    foreign = await _make_workspace(f.db, test_user, name="Other", slug="other")
    # A stale/corrupt binding must not silently qualify a different credential.
    f.connection.workspace_id = foreign.id
    await f.db.flush()
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is False
    assert any(
        check["required"]
        and check["status"] == "failed"
        and check["code"] == "credential_unavailable"
        for check in body["checks"]
    )
    assert forge_http.requests == []


@pytest.mark.parametrize("failure", ["api-host", "corrupt-token"])
async def test_readiness_rejects_unsafe_credential_before_network(
    client, readiness_fixture, forge_http, monkeypatch, caplog, failure
):
    f = readiness_fixture
    if failure == "api-host":
        monkeypatch.setattr(
            settings, "GITHUB_API_URL", "https://unexpected.example.invalid"
        )
        expected = "credential_host_mismatch"
    else:
        f.connection.encrypted_access_token = b"invalid-encrypted-fixture-token"
        await f.db.flush()
        expected = "credential_unavailable"
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is False
    binding = check_for(body, "repository_binding")
    assert binding["status"] == "failed"
    assert binding["code"] == expected
    assert forge_http.requests == []
    assert_private(response, caplog)


@pytest.mark.parametrize(
    "path,operation,payload",
    [
        (REPO_PATH, "repository_read", []),
        (f"{REPO_PATH}/pulls", "pull_requests_read", {}),
    ],
)
async def test_readiness_malformed_success_body_is_not_verified(
    client, readiness_fixture, forge_http, path, operation, payload, caplog
):
    f = readiness_fixture
    forge_http.payloads[path] = payload
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ready"] is False
    check = check_for(body, operation)
    assert check["status"] == "failed"
    assert check["code"] == "forge_response_invalid"
    assert_private(response, caplog)
