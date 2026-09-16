# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import AsyncMock, patch
import httpx

from tests.test_postmerge_acceptance import completion_fixture, policy, status, submit
from app.services.kanban.reconciler import MergedPRReconciler
from app.services.git.git_repo import GitRepoService
from app.schemas.git.git_repo import GitRepoUpdate
from app.services.github_client import GitHubClient

__all__ = ["completion_fixture"]

async def test_repo_edit_revert_must_invalidate(client, agent_client, completion_fixture):
    f = completion_fixture
    await client.put(f"{f.url}/policy", json={"policy": policy(source_review="none", review_role=None, postmerge_validation=None, auto_complete=False)})
    current = status()
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(side_effect=lambda *a, **k: current)):
        await submit(agent_client, f)
        current = status(merged=True)
        await MergedPRReconciler(None).scan_once(f.db)
    original = f.repo.default_branch
    for branch in ("replacement-main", original):
        await GitRepoService(f.db).update_git_repo(f.repo.id, f.board.id, GitRepoUpdate(default_branch=branch), workspace_id=f.board.workspace_id, actor_id=f.card.created_by)
    public = await client.get(f"{f.url}/cards/{f.card.id}")
    candidate = public.json()["candidate"]
    assert candidate is None or candidate["status"] == "stale"

async def test_stale_check_is_not_green():
    client = GitHubClient("fixture")
    client.get_pr_status = AsyncMock(return_value=status())
    client._request = AsyncMock(side_effect=[httpx.Response(200, json={"check_runs": [{"status": "completed", "conclusion": "stale"}]}), httpx.Response(200, json={"statuses": []})])
    assert await client.get_pr_ci_state("https://github.com/valaris/test-repo/pull/17") != "green"

async def test_truncated_checks_are_not_green():
    client = GitHubClient("fixture")
    client.get_pr_status = AsyncMock(return_value=status())
    client._request = AsyncMock(side_effect=[httpx.Response(200, json={"total_count": 31, "check_runs": [{"status": "completed", "conclusion": "success"}] * 30}, headers={"Link": '<https://api.github.com/next>; rel="next"'}), httpx.Response(200, json={"statuses": []})])
    assert await client.get_pr_ci_state("https://github.com/valaris/test-repo/pull/17") != "green"


async def test_viewer_cannot_restart_merge_queue(client, db_session, test_workspace, test_board, test_card, test_git_repo, test_user):
    from sqlalchemy import select
    from app.models.agents.merge_queue import MergeQueueEntry
    from app.models.workspace import WorkspaceMember, WorkspaceRole
    entry = MergeQueueEntry(card_id=test_card.id, repo_id=test_git_repo.id, workspace_id=test_workspace.id,
                            integration_branch="main", pr_url="https://github.com/valaris/test-repo/pull/1", pr_branch="work", state="failed")
    db_session.add(entry)
    member = await db_session.scalar(select(WorkspaceMember).where(WorkspaceMember.workspace_id == test_workspace.id, WorkspaceMember.user_id == test_user.id))
    member.role = WorkspaceRole.viewer
    await db_session.flush()
    response = await client.post("/api/workspaces/default/merge-queue/re-enqueue", json={"card_id": str(test_card.id)})
    assert response.status_code == 403, response.text
    await db_session.refresh(entry)
    assert entry.state == "failed"


async def test_merge_worker_locks_workspace_before_queue_row(db_session, test_workspace, test_board, test_card, test_git_repo):
    from app.models.agents.merge_queue import MergeQueueEntry
    from app.services.completion_policy import CompletionPolicyService
    from app.services.merge_queue import MergeQueueService
    entry = MergeQueueEntry(card_id=test_card.id, repo_id=test_git_repo.id, workspace_id=test_workspace.id,
                            integration_branch="main", pr_url="https://github.com/valaris/test-repo/pull/1", pr_branch="work", state="queued")
    db_session.add(entry)
    await db_session.flush()
    calls = []
    service = MergeQueueService(db_session)
    original_pop = service.repo.pop_next
    original_lock = CompletionPolicyService.lock_board_for_completion
    async def pop(**kwargs):
        calls.append("queue")
        return await original_pop(**kwargs)
    async def lock(instance, *args, **kwargs):
        calls.append("workspace")
        return await original_lock(instance, *args, **kwargs)
    service.repo.pop_next = pop
    with patch.object(CompletionPolicyService, "lock_board_for_completion", new=lock):
        await service.tick(executor=AsyncMock(return_value=("failed", "fixture no merge")))
    assert calls.index("workspace") < calls.index("queue")
