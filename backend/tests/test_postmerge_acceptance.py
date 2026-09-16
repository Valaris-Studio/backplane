# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import uuid

import pytest
from sqlalchemy import select

from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.merge_queue import MergeQueueEntry
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.workspace_config import WorkspaceConfig
from app.services.kanban.reconciler import MergedPRReconciler

HEAD = "a" * 40
MERGED = "b" * 40
PR = "https://github.com/valaris/test-repo/pull/17"


def policy(**overrides):
    return {
        "version": 1,
        "landing_actor": "platform",
        "landing_methods": ["merge_queue"],
        "source_review": "independent",
        "review_role": "custom-arbiter",
        "require_forge_checks": False,
        "postmerge_validation": {
            "role": "custom-validation",
            "checks": [
                {"id": "local-ci", "argv": ["just", "ci"], "timeout_seconds": 60},
            ],
        },
        "evidence_only": {
            "enabled": True,
            "approval": "independent",
            "review_role": "custom-arbiter",
        },
        "dependency_release": "done",
        "auto_complete": True,
        **overrides,
    }


@pytest.fixture
async def completion_fixture(
    client, db_session, test_board, test_card, test_git_repo, test_workspace, test_agent
):
    config = await db_session.scalar(
        select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == test_workspace.id)
    )
    if config is None:
        config = WorkspaceConfig(workspace_id=test_workspace.id)
        db_session.add(config)
    config.pipeline_config = {
        "stages": [
            {
                "role": role,
                "enabled": True,
                "llm": {"provider": "codex-cli", "model": "fixture-review-model"},
            }
            for role in ("custom-arbiter", "custom-validation")
        ]
    }
    test_card.pr_url = PR
    test_card.branch_name = "feature/accepted"
    test_card.git_repo_slug = test_git_repo.slug
    column = await db_session.get(Column, test_card.column_id)
    column.column_type = ColumnType.review
    done = Column(
        board_id=test_board.id,
        name="Complete",
        column_type=ColumnType.done,
        position=4096,
    )
    db_session.add(done)
    execution = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="loop_iteration",
        role="builder",
        status=ExecutionStatus.completed,
        cards_affected=[str(test_card.id)],
        provider="codex-cli",
        model="fixture-builder",
    )
    db_session.add(execution)
    await db_session.flush()
    url = f"/api/workspaces/default/boards/{test_board.id}/completion"
    saved = await client.put(f"{url}/policy", json={"policy": policy()})
    assert saved.status_code == 200, saved.text
    return SimpleNamespace(
        url=url,
        execution=execution,
        card=test_card,
        board=test_board,
        repo=test_git_repo,
        done=done,
        db=db_session,
    )


def status(merged=False, head=HEAD, merge_sha=MERGED):
    return SimpleNamespace(
        merged=merged,
        state="closed" if merged else "open",
        mergeable=True,
        head_sha=head,
        merge_commit_sha=merge_sha if merged else None,
        head_branch="feature/accepted",
        base_branch="main",
        base_repo_url="https://github.com/valaris/test-repo",
    )


async def submit(agent_client, fixture, **extra):
    response = await agent_client.post(
        f"{fixture.url}/cards/{fixture.card.id}/submit",
        json={
            "source_execution_id": str(fixture.execution.id),
            **extra,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["candidate"]


async def claim(agent_client, fixture):
    response = await agent_client.post(
        f"{fixture.url}/work/claim",
        json={
            "capabilities": {
                "providers": ["codex-cli"],
                "exact_checkout": True,
                "argv_checks": True,
            }
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["work"]


def result(work, outcome="passed"):
    return {
        "lease_token": work["lease_token"],
        "candidate_id": work["candidate_id"],
        "policy_hash": work["policy_hash"],
        "contract_hash": work["contract_hash"],
        "source_sha": work["source_sha"],
        "outcome": outcome,
        "summary": "Fixture observed outcome",
        "checks": (
            [
                {
                    "id": "local-ci",
                    "exit_code": 0 if outcome == "passed" else 1,
                    "source_sha": work["source_sha"],
                    "output": "bounded fixture output",
                }
            ]
            if work["kind"] == "validation"
            else []
        ),
    }


async def acknowledge(agent_client, fixture, work, payload=None):
    return await agent_client.post(
        f"{fixture.url}/work/{work['attempt_id']}/result", json=payload or result(work)
    )


async def test_reviewed_merge_holds_dependency_until_exact_validation_and_idempotent_ack(
    client,
    agent_client,
    completion_fixture,
):
    f = completion_fixture
    dependent = Card(
        board_id=f.board.id,
        column_id=f.card.column_id,
        title="Dependent",
        position=2048,
        created_by=f.card.created_by,
    )
    f.db.add(dependent)
    await f.db.flush()
    dep_url = (
        f"/api/workspaces/default/boards/{f.board.id}/cards/{dependent.id}/dependencies"
    )
    dependency = await client.post(dep_url, json={"depends_on_card_id": str(f.card.id)})
    assert dependency.status_code in (200, 201), dependency.text
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *a, **k: current),
    ):
        candidate = await submit(agent_client, f)
        assert candidate["status"] == "awaiting_review"
        duplicate = await submit(agent_client, f)
        assert duplicate["id"] == candidate["id"]
        review = await claim(agent_client, f)
        assert review["kind"] == "review"
        assert review["role"] == "custom-arbiter"
        assert review["source_sha"] == HEAD
        assert review["execution_id"] != str(f.execution.id)
        assert await claim(agent_client, f) is None
        accepted_review = await acknowledge(agent_client, f, review)
        assert accepted_review.status_code == 200, accepted_review.text
        queue = await f.db.scalar(
            select(MergeQueueEntry).where(MergeQueueEntry.card_id == f.card.id)
        )
        assert queue is not None
        current = status(merged=True)
        await MergedPRReconciler(None).scan_once(f.db)
        await f.db.refresh(f.card)
        assert f.card.column_id != f.done.id
        held = await client.get(f"{dep_url}/status")
        assert held.status_code == 200, held.text
        assert held.json()["ready"] is False
        work = await claim(agent_client, f)
        assert work["kind"] == "validation"
        assert work["source_sha"] == MERGED
        failed = await acknowledge(agent_client, f, work, result(work, "failed"))
        assert failed.status_code == 200, failed.text
        public = await client.get(f"{f.url}/cards/{f.card.id}")
        assert public.json()["candidate"]["status"] == "failed"
        assert "lease_token" not in public.text
        assert (await client.get(f"{dep_url}/status")).json()["ready"] is False
        retry = await agent_client.post(f"{f.url}/cards/{f.card.id}/retry", json={})
        assert retry.status_code == 200, retry.text
        retried = await claim(agent_client, f)
        stale_payload = result(retried)
        stale_payload["source_sha"] = "c" * 40
        stale = await acknowledge(agent_client, f, retried, stale_payload)
        assert stale.status_code == 409, stale.text
        assert (await client.get(f"{dep_url}/status")).json()["ready"] is False
        passed = await acknowledge(agent_client, f, retried)
        assert passed.status_code == 200, passed.text
        duplicate = await acknowledge(agent_client, f, retried)
        assert duplicate.status_code == 200, duplicate.text
        await f.db.refresh(f.card)
        assert f.card.column_id == f.done.id
        assert (await client.get(f"{dep_url}/status")).json()["ready"] is True
        # Advancing main is not a different merge candidate.
        await MergedPRReconciler(None).scan_once(f.db)
        assert (await client.get(f"{dep_url}/status")).json()["ready"] is True


async def test_policy_change_invalidates_claim_before_ack(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        work = await claim(agent_client, f)
        changed = await client.put(
            f"{f.url}/policy", json={"policy": policy(auto_complete=False)}
        )
        assert changed.status_code == 200, changed.text
        rejected = await acknowledge(agent_client, f, work)
        assert rejected.status_code == 200, rejected.text
        assert rejected.json()["result_receipt"]["status"] == "rejected"
        await f.db.refresh(f.card)
        assert f.card.column_id != f.done.id


async def test_forged_lease_and_foreign_execution_cannot_complete(
    agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        invalid = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/submit",
            json={"source_execution_id": str(uuid.uuid4())},
        )
        assert invalid.status_code == 404, invalid.text
        await submit(agent_client, f)
        work = await claim(agent_client, f)
        forged = deepcopy(result(work))
        forged["lease_token"] = "forged"
        response = await acknowledge(agent_client, f, work, forged)
        assert response.status_code in (403, 404), response.text
        assert work["lease_token"] not in response.text


async def test_unavailable_forge_does_not_accept_source(
    agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=None),
    ):
        response = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/submit",
            json={"source_execution_id": str(f.execution.id)},
        )
        assert response.status_code in (409, 422, 502), response.text
        await f.db.refresh(f.card)
        assert f.card.column_id != f.done.id


async def test_queue_rechecks_current_candidate_before_executor(
    client, agent_client, completion_fixture
):
    from app.services.merge_queue import MergeQueueService
    from app.utils import utcnow

    f = completion_fixture
    await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                source_review="none", review_role=None, postmerge_validation=None
            )
        },
    )
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        landing = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/land", json={"method": "merge_queue"}
        )
        assert landing.status_code == 200, landing.text
        await client.put(
            f"{f.url}/policy",
            json={
                "policy": policy(
                    landing_actor="human",
                    landing_methods=["external"],
                    source_review="none",
                    review_role=None,
                    postmerge_validation=None,
                )
            },
        )
        executor = AsyncMock(return_value=("merged", utcnow()))
        await MergeQueueService(f.db).tick(executor=executor)
        executor.assert_not_awaited()
        entry = await f.db.scalar(
            select(MergeQueueEntry).where(MergeQueueEntry.card_id == f.card.id)
        )
        assert entry.state == "failed"
        assert "completion" in entry.error_message.lower()


async def test_explicit_merge_poll_finds_candidate_outside_review_column(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                source_review="none", review_role=None, postmerge_validation=None
            )
        },
    )
    column = await f.db.get(Column, f.card.column_id)
    column.column_type = ColumnType.active
    await f.db.flush()
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *a, **k: current),
    ):
        await submit(agent_client, f)
        current = status(merged=True)
        await MergedPRReconciler(None).scan_once(f.db)
        public = await client.get(f"{f.url}/cards/{f.card.id}")
        assert public.json()["candidate"]["status"] == "accepted"
        assert public.json()["candidate"]["merge_sha"] == MERGED


async def test_review_result_rejects_changed_provider_configuration(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await client.put(f"{f.url}/policy", json={"policy": policy(landing_actor="agent")})
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        work = await claim(agent_client, f)
        config = await f.db.scalar(
            select(WorkspaceConfig).where(
                WorkspaceConfig.workspace_id == f.board.workspace_id
            )
        )
        config.pipeline_config = {
            "stages": [
                {
                    "role": "custom-arbiter",
                    "llm": {
                        "provider": "different-provider",
                        "model": "different-model",
                    },
                }
            ]
        }
        await f.db.flush()
        response = await acknowledge(agent_client, f, work)
        assert response.status_code == 200, response.text
        assert response.json()["result_receipt"]["code"] == "completion_role_changed"


async def test_external_merge_requires_verified_forge_checks(
    client, agent_client, completion_fixture
):
    from app.exceptions import ConflictError
    from app.services.completion import CompletionService

    f = completion_fixture
    await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                landing_actor="human",
                landing_methods=["external"],
                require_forge_checks=True,
            )
        },
    )
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        work = await claim(agent_client, f)
        assert (await acknowledge(agent_client, f, work)).status_code == 200
    merged = status(merged=True)
    merged.checks_passed = False
    with pytest.raises(ConflictError):
        await CompletionService(f.db).record_merge(f.board, f.card, merged)
    current = await client.get(f"{f.url}/cards/{f.card.id}")
    assert current.json()["candidate"]["merge_sha"] is None


async def test_viewer_runner_cannot_submit_completion(
    client, agent_client, completion_fixture, test_user
):
    from app.models.workspace import WorkspaceMember, WorkspaceRole

    f = completion_fixture
    member = await f.db.scalar(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == f.board.workspace_id,
            WorkspaceMember.user_id == test_user.id,
        )
    )
    member.role = WorkspaceRole.viewer
    await f.db.flush()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        response = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/submit",
            json={"source_execution_id": str(f.execution.id)},
        )
    assert response.status_code == 403, response.text


async def test_source_review_cannot_retroactively_approve_unreviewed_merge(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await client.put(f"{f.url}/policy", json={"policy": policy(landing_actor="agent")})
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *a, **k: current),
    ):
        await submit(agent_client, f)
        work = await claim(agent_client, f)
        current = status(merged=True)
        response = await acknowledge(
            agent_client, f, work, {**result(work), "cost_usd": 0.75}
        )
        assert response.status_code == 200, response.text
        assert (
            response.json()["result_receipt"]["code"] == "completion_review_after_merge"
        )
        assert response.json()["result_receipt"]["retryable"] is False
        assert response.json()["candidate"]["status"] == "stale"
        assert await claim(agent_client, f) is None
        execution = await f.db.get(AgentExecution, uuid.UUID(work["execution_id"]))
        assert (
            execution.status == ExecutionStatus.aborted and execution.cost_usd == 0.75
        )


@pytest.mark.parametrize("identity_change", [None, "head_sha", "merge_commit_sha"])
async def test_validation_check_loss_retires_lease_and_requires_explicit_retry(
    client, agent_client, completion_fixture, identity_change
):
    from app.services.completion import CompletionService
    from app.models.kanban.completion import CompletionAttempt

    f = completion_fixture
    saved = await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                landing_actor="agent",
                source_review="none",
                review_role=None,
                require_forge_checks=True,
            )
        },
    )
    assert saved.status_code == 200, saved.text
    current = status()
    current.checks_passed = True
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *a, **k: current),
    ):
        await submit(agent_client, f)
        current = status(merged=True)
        current.checks_passed = True
        await CompletionService(f.db).record_merge(f.board, f.card, current)
        work = await claim(agent_client, f)
        current.checks_passed = False
        if identity_change:
            setattr(current, identity_change, "c" * 40)
        payload = {**result(work), "cost_usd": 0.25}
        response = await acknowledge(agent_client, f, work, payload)
        assert response.status_code == 200, response.text
        if identity_change:
            assert (
                response.json()["result_receipt"]["code"]
                == "completion_candidate_stale"
            )
            assert response.json()["result_receipt"]["retryable"] is False
            assert response.json()["candidate"]["status"] == "stale"
            assert (
                await client.post(f"{f.url}/cards/{f.card.id}/retry")
            ).status_code == 409
            assert await claim(agent_client, f) is None
            return
        assert (
            response.json()["result_receipt"]["code"]
            == "completion_forge_checks_required"
        )
        assert response.json()["result_receipt"]["retryable"] is True
        assert response.json()["candidate"]["status"] == "failed"
        assert await claim(agent_client, f) is None
        assert (
            await f.db.get(AgentExecution, uuid.UUID(work["execution_id"]))
        ).cost_usd == 0.25
        current.checks_passed = True
        assert (
            await client.post(f"{f.url}/cards/{f.card.id}/retry")
        ).status_code == 200
        successor = await claim(agent_client, f)
        replay = await acknowledge(agent_client, f, work, payload)
        assert replay.json()["result_receipt"] == response.json()["result_receipt"]
        assert (
            await f.db.get(CompletionAttempt, uuid.UUID(successor["attempt_id"]))
        ).status == "claimed"


async def test_validation_requires_complete_exact_contract_after_merge(
    client, agent_client, completion_fixture
):
    from app.services.completion import CompletionService

    f = completion_fixture
    await client.put(
        f"{f.url}/policy",
        json={
            "policy": policy(
                landing_actor="agent", source_review="none", review_role=None
            )
        },
    )
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *a, **k: current),
    ):
        await submit(agent_client, f)
        current = status(merged=True)
        await CompletionService(f.db).record_merge(f.board, f.card, current)
        work = await claim(agent_client, f)
        assert work["source_sha"] == MERGED
        rejected = await acknowledge(
            agent_client, f, work, {**result(work), "checks": []}
        )
        assert rejected.status_code == 409
        accepted = await acknowledge(agent_client, f, work)
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["candidate"]["status"] == "accepted"
        duplicate = await acknowledge(agent_client, f, work)
        assert duplicate.status_code == 200
        changed = await acknowledge(
            agent_client, f, work, {**result(work), "summary": "Different result"}
        )
        assert changed.status_code == 409


async def test_expired_claim_can_resume_but_old_result_stays_rejected(
    client, agent_client, completion_fixture
):
    from datetime import timedelta
    from app.models.kanban.completion import CompletionAttempt
    from app.services.completion import naive_now

    f = completion_fixture
    await client.put(f"{f.url}/policy", json={"policy": policy(landing_actor="agent")})
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        old = await claim(agent_client, f)
        attempt = await f.db.get(CompletionAttempt, uuid.UUID(old["attempt_id"]))
        attempt.expires_at = naive_now() - timedelta(seconds=1)
        await f.db.flush()
        fresh = await claim(agent_client, f)
        assert fresh["attempt_id"] != old["attempt_id"]
        rejected = await acknowledge(agent_client, f, old)
        assert rejected.status_code == 200
        assert rejected.json()["result_receipt"]["status"] == "rejected"
        assert rejected.json()["result_receipt"]["retryable"] is False
        assert (await acknowledge(agent_client, f, fresh)).status_code == 200
