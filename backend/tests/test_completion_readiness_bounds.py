# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import asyncio
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from sqlalchemy import select

from app.config import settings
from app.models.git.git_repo import GitRepo
from app.models.kanban.completion import CompletionCandidate
from app.repositories.git.git_repo import GitRepoRepository
from app.services import completion_readiness
from tests.test_completion_readiness import (
    completion_fixture,
    forge_http,
    readiness_fixture,
)
from tests.test_postmerge_acceptance import status, submit

__all__ = ["completion_fixture", "forge_http", "readiness_fixture"]
pytestmark = pytest.mark.slow


async def test_readiness_deadline_includes_database_resolution(
    client, readiness_fixture, forge_http, monkeypatch,
):
    async def slow_list(self, board_id):
        await asyncio.Event().wait()

    monkeypatch.setattr(GitRepoRepository, "list_by_board", slow_list)
    monkeypatch.setattr(completion_readiness, "READINESS_TIMEOUT_SECONDS", 0.02)
    response = await asyncio.wait_for(
        client.get(f"{readiness_fixture.url}/readiness"), timeout=0.5,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["ready"] is False
    assert any(check["required"] and check["status"] == "unverified"
               and check["code"] == "readiness_timeout" for check in body["checks"])
    assert forge_http.requests == []


@pytest.mark.parametrize("key", ["", "invalid-vault-key-fixture"])
async def test_readiness_unusable_vault_is_safe_failure(
    client, readiness_fixture, forge_http, monkeypatch, key,
):
    monkeypatch.setattr(settings, "INTEGRATIONS_TOKEN_KEY", key)
    response = await client.get(f"{readiness_fixture.url}/readiness")
    assert response.status_code == 200
    assert response.json()["ready"] is False
    assert any(check["code"] == "credential_unavailable" for check in response.json()["checks"])
    assert forge_http.requests == []


async def test_readiness_bounds_concurrent_requests_for_all_linked_repos(
    client, readiness_fixture, forge_http, monkeypatch,
):
    f = readiness_fixture
    for index in range(5):
        f.db.add(GitRepo(
            board_id=f.board.id, workspace_id=f.board.workspace_id,
            name=f"Additional {index}", slug=f"additional-{index}",
            url=f.repo.url, provider=f.repo.provider, added_by=f.repo.added_by,
            connection_id=f.connection.id,
        ))
    await f.db.flush()
    original = httpx.AsyncClient.send
    active = peak = 0

    async def delayed_send(client, request, **kwargs):
        nonlocal active, peak
        if isinstance(client._transport, httpx.ASGITransport):
            return await original(client, request, **kwargs)
        active += 1
        peak = max(active, peak)
        try:
            await asyncio.sleep(0.01)
            return await original(client, request, **kwargs)
        finally:
            active -= 1

    monkeypatch.setattr(httpx.AsyncClient, "send", delayed_send)
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200
    assert response.json()["ready"] is True
    assert len(forge_http.requests) == 12
    assert peak == 4
    assert active == 0


async def test_readiness_deadline_cancels_network_and_discards_partial_success(
    client, readiness_fixture, forge_http, monkeypatch,
):
    original = httpx.AsyncClient.send
    cancelled = asyncio.Event()

    async def blocked_send(client, request, **kwargs):
        if not isinstance(client._transport, httpx.ASGITransport) and request.url.path.endswith("/pulls"):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        return await original(client, request, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, "send", blocked_send)
    monkeypatch.setattr(completion_readiness, "READINESS_TIMEOUT_SECONDS", 0.05)
    response = await asyncio.wait_for(
        client.get(f"{readiness_fixture.url}/readiness"), timeout=0.5,
    )
    assert response.status_code == 200
    assert response.json()["ready"] is False
    assert any(check["required"] and check["status"] == "unverified"
               and check["code"] == "readiness_timeout" for check in response.json()["checks"])
    assert cancelled.is_set()


async def test_readiness_excludes_stale_candidate_without_mutation(
    client, agent_client, readiness_fixture, forge_http,
):
    f = readiness_fixture
    with patch("app.services.kanban.reconciler.board_scoped_pr_status",
               new=AsyncMock(return_value=status())):
        await submit(agent_client, f)
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    before = (candidate.status, candidate.is_current, candidate.updated_at)
    f.card.title += " changed after submission"
    await f.db.flush()
    response = await client.get(f"{f.url}/readiness")
    assert response.status_code == 200
    assert response.json()["ready"] is True
    assert not any(check["operation"] == "candidate_pr_read" for check in response.json()["checks"])
    assert not any(path.endswith("/pulls/17") for path, _ in forge_http.requests)
    await f.db.refresh(candidate)
    assert (candidate.status, candidate.is_current, candidate.updated_at) == before
