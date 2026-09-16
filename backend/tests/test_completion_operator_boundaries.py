# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import AsyncMock, patch
from tests.test_postmerge_acceptance import completion_fixture, policy, status, submit
from app.services.kanban.reconciler import MergedPRReconciler
from app.models.kanban.completion import CompletionCandidate
from sqlalchemy import select

__all__ = ["completion_fixture"]


async def _accepted(client, agent_client, f):
    saved = await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                source_review="none",
                review_role=None,
                postmerge_validation=None,
                auto_complete=False,
            )
        },
    )
    assert saved.status_code == 200, saved.text
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *a, **k: current),
    ):
        await submit(agent_client, f)
        current = status(merged=True)
        await MergedPRReconciler(None).scan_once(f.db)


async def test_agent_cannot_move_manually_accepted_work_to_done(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await _accepted(client, agent_client, f)
    response = await agent_client.patch(
        f"/api/workspaces/default/boards/{f.board.id}/cards/{f.card.id}/move",
        json={"column_id": str(f.done.id)},
    )
    assert response.status_code == 403, response.status_code


async def test_repository_delete_with_completion_history_is_handled(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await _accepted(client, agent_client, f)
    original_url = f.repo.url
    response = await client.delete(
        f"/api/workspaces/default/boards/{f.board.id}/git-repos/{f.repo.id}"
    )
    assert response.status_code == 204, response.text
    candidate = await f.db.scalar(
        select(CompletionCandidate).where(CompletionCandidate.card_id == f.card.id)
    )
    await f.db.refresh(candidate)
    assert candidate.repo_id is None
    assert candidate.repo_url == original_url
    assert candidate.status == "stale"
    assert candidate.is_current is False


async def test_agent_cannot_erase_completion_role_configuration(
    agent_client, completion_fixture
):
    response = await agent_client.patch(
        "/api/workspaces/default/config", json={"pipeline_config": None}
    )
    assert response.status_code == 403, response.status_code


async def test_readiness_exposes_pending_completion_separately_from_source_work(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
    response = await client.get(
        f"/api/workspaces/default/boards/{f.board.id}/loop/readiness"
    )
    assert response.status_code == 200, response.text
    assert response.json()["pending_completion"] == 1
    assert response.json()["failed_completion"] == 0
