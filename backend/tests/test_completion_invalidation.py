# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import AsyncMock, patch

from tests.test_postmerge_acceptance import completion_fixture, policy, status, submit

__all__ = ["completion_fixture"]


async def test_card_edit_and_revert_cannot_resurrect_accepted_candidate(client, agent_client, completion_fixture):
    from app.services.kanban.reconciler import MergedPRReconciler
    f = completion_fixture
    await client.put(f"{f.url}/policy", json={"policy": policy(source_review="none", review_role=None, postmerge_validation=None, auto_complete=False)})
    current = status()
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(side_effect=lambda *a, **k: current)):
        await submit(agent_client, f)
        current = status(merged=True)
        await MergedPRReconciler(None).scan_once(f.db)
    card_url = f"/api/workspaces/default/boards/{f.board.id}/cards/{f.card.id}"
    original = f.card.title
    for title in (original + " edited", original):
        response = await client.patch(card_url, json={"title": title})
        assert response.status_code == 200, response.text
    public = await client.get(f"{f.url}/cards/{f.card.id}")
    candidate = public.json()["candidate"]
    assert candidate is None or candidate["status"] == "stale"


async def test_runner_cannot_stop_as_objective_complete_with_pending_acceptance(client, agent_client, completion_fixture):
    f = completion_fixture
    loop_url = f"/api/workspaces/default/boards/{f.board.id}/loop"
    saved = await client.put(loop_url, json={"enabled": True, "loop_prompt": "Work"})
    assert saved.status_code == 200, saved.text
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(return_value=status())):
        await submit(agent_client, f)
    response = await agent_client.patch(f"{loop_url}/state", json={"enabled": False, "reason": "objective_complete"})
    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "completion_work_pending"
    human_stop = await client.patch(f"{loop_url}/state", json={"enabled": False, "reason": "operator stopped"})
    assert human_stop.status_code == 200, human_stop.text


async def test_inherited_workspace_policy_edit_and_revert_invalidates_candidate(client, agent_client, completion_fixture):
    f = completion_fixture
    initial = policy(source_review="none", review_role=None, postmerge_validation=None, auto_complete=False)
    saved = await client.patch("/api/workspaces/default/config", json={"completion_policy": initial})
    assert saved.status_code == 200, saved.text
    assert (await client.put(f"{f.url}/policy", json={"policy": None})).status_code == 200
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(return_value=status())):
        await submit(agent_client, f)
    for current in ({**initial, "auto_complete": True}, initial):
        response = await client.patch("/api/workspaces/default/config", json={"completion_policy": current})
        assert response.status_code == 200, response.text
    public = await client.get(f"{f.url}/cards/{f.card.id}")
    candidate = public.json()["candidate"]
    assert candidate is None or candidate["status"] == "stale"


async def test_precommit_merge_event_returns_before_taking_worker_locks(db_engine, db_session, test_board, test_card, test_git_repo, test_workspace):
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
    from app.core.event_bus import Event
    from app.models.agents.merge_queue import MergeQueueEntry
    from app.services.kanban.reconciler import MergedPRReconciler
    entry = MergeQueueEntry(card_id=test_card.id, repo_id=test_git_repo.id, workspace_id=test_workspace.id,
                            pr_url="https://github.com/valaris/test-repo/pull/1", pr_branch="branch", integration_branch="main", state="queued")
    db_session.add(entry)
    await db_session.commit()
    factory = async_sessionmaker(db_engine, class_=AsyncSession, expire_on_commit=False)
    event = Event(event_type="merge_queue.merged", workspace_id=test_workspace.id,
                  payload={"entry_id": str(entry.id), "card_id": str(test_card.id), "repo_id": str(test_git_repo.id), "pr_url": entry.pr_url})
    with patch("app.services.completion_policy.CompletionPolicyService.lock_board_for_completion", new=AsyncMock()) as lock:
        await MergedPRReconciler(factory)._handle_event(event)
        lock.assert_not_awaited()


async def test_active_loop_source_is_attributed_to_card_by_submission(agent_client, completion_fixture):
    from app.models.agents.execution import ExecutionStatus
    f = completion_fixture
    f.execution.status = ExecutionStatus.started
    f.execution.role = None
    f.execution.cards_affected = None
    await f.db.flush()
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(return_value=status())):
        candidate = await submit(agent_client, f)
    await f.db.refresh(f.execution)
    assert str(f.card.id) in f.execution.cards_affected
    assert candidate["source_execution_id"] == str(f.execution.id)


async def test_completed_unattributed_source_cannot_claim_new_card(agent_client, completion_fixture):
    f = completion_fixture
    f.execution.cards_affected = None
    await f.db.flush()
    with patch("app.services.kanban.reconciler.board_scoped_pr_status", new=AsyncMock(return_value=status())):
        response = await agent_client.post(f"{f.url}/cards/{f.card.id}/submit", json={"source_execution_id": str(f.execution.id)})
    assert response.status_code == 404, response.text
