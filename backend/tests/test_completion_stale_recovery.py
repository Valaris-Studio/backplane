# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy
from unittest.mock import AsyncMock, patch
import uuid

from sqlalchemy import select

from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.agents.prompt_config import AgentPromptConfig
from app.models.kanban.completion import CompletionAttempt
from tests.test_completion_execution_boundaries import _claim, _configure_role
from tests.test_postmerge_acceptance import (
    acknowledge,
    claim,
    completion_fixture,
    result,
    status,
)

__all__ = ["completion_fixture"]


async def change_context(f):
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    prompt.content += " Newly required inspection."
    prompt.version += 1
    await f.db.flush()


async def stale_result(agent_client, f):
    await _configure_role(f)
    work = await _claim(agent_client, f)
    await change_context(f)
    payload = {
        **result(work),
        "tokens_used": 321,
        "cost_usd": 0.75,
        "duration_seconds": 46,
    }
    return work, payload, await acknowledge(agent_client, f, work, payload)


async def test_context_rejection_retires_lease_preserves_candidate_and_records_usage(
    agent_client, completion_fixture
):
    f = completion_fixture
    work, payload, response = await stale_result(agent_client, f)
    assert response.status_code == 200, response.text
    receipt = response.json()["result_receipt"]
    changed = receipt.pop("changed_sources")
    assert (
        len(changed) == 1
        and changed[0]["kind"] == "prompt"
        and changed[0]["change"] == "changed"
    )
    assert receipt == {
        "attempt_id": work["attempt_id"],
        "status": "rejected",
        "code": "completion_context_changed",
        "retryable": True,
        "next_action": "retry_completion",
    }
    candidate = response.json()["candidate"]
    assert candidate["id"] == work["candidate_id"]
    assert candidate["status"] == "failed"
    assert candidate["review_passed"] is False
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    execution = await f.db.get(AgentExecution, uuid.UUID(work["execution_id"]))
    assert attempt.status == "rejected"
    assert attempt.completed_at is not None
    assert attempt.result["summary"] == payload["summary"]
    assert "lease_token" not in attempt.result
    assert execution.status == ExecutionStatus.aborted
    assert (execution.tokens_used, execution.cost_usd, execution.duration_seconds) == (
        321,
        0.75,
        46,
    )


async def test_rejected_result_replay_cannot_retire_successor_or_double_charge(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work, payload, rejected = await stale_result(agent_client, f)
    assert rejected.status_code == 200, rejected.text
    retry = await client.post(f"{f.url}/cards/{f.card.id}/retry")
    assert retry.status_code == 200, retry.text
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        successor = await claim(agent_client, f)
    assert successor and successor["attempt_id"] != work["attempt_id"]
    replay = await acknowledge(agent_client, f, work, payload)
    assert replay.status_code == 200, replay.text
    assert replay.json()["result_receipt"] == rejected.json()["result_receipt"]
    assert replay.json()["candidate"]["status"] == "awaiting_review"
    active = await f.db.get(CompletionAttempt, uuid.UUID(successor["attempt_id"]))
    assert active.status == "claimed"
    assert await claim(agent_client, f) is None
    changed = await acknowledge(agent_client, f, work, {**payload, "cost_usd": 999})
    assert changed.status_code == 409
    original = await f.db.get(AgentExecution, uuid.UUID(work["execution_id"]))
    assert original.cost_usd == 0.75


async def test_wrong_lease_cannot_retire_changed_context_attempt(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    await change_context(f)
    response = await acknowledge(
        agent_client, f, work, {**result(work), "lease_token": "wrong"}
    )
    assert response.status_code == 403
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    assert attempt.status == "claimed"
    assert attempt.result is None


async def test_wrong_candidate_cannot_retire_changed_context_attempt(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    await change_context(f)
    payload = deepcopy(result(work))
    payload["candidate_id"] = str(uuid.uuid4())
    response = await acknowledge(agent_client, f, work, payload)
    assert response.status_code == 409
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    assert attempt.status == "claimed"


async def test_rejected_receipt_commits_through_real_request_dependency(
    agent_client, completion_fixture, db_engine, monkeypatch
):
    from sqlalchemy.ext.asyncio import async_sessionmaker
    from app import database

    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    await change_context(f)
    await f.db.commit()
    session_factory = async_sessionmaker(db_engine, expire_on_commit=False)
    monkeypatch.setattr(database, "async_session", session_factory)
    app = agent_client._transport.app
    original = app.dependency_overrides.pop(database.get_db)
    try:
        response = await acknowledge(
            agent_client, f, work, {**result(work), "cost_usd": 0.75}
        )
    finally:
        app.dependency_overrides[database.get_db] = original
    assert response.status_code == 200, response.text
    async with session_factory() as independent:
        attempt = await independent.get(
            CompletionAttempt, uuid.UUID(work["attempt_id"])
        )
        execution = await independent.get(
            AgentExecution, uuid.UUID(work["execution_id"])
        )
        assert attempt.status == "rejected"
        assert attempt.result["receipt"]["code"] == "completion_context_changed"
        assert execution.cost_usd == 0.75
        assert execution.status == ExecutionStatus.aborted


async def test_deleted_prompt_retires_attempt_with_actionable_configuration_receipt(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    await f.db.delete(prompt)
    await f.db.flush()
    response = await acknowledge(agent_client, f, work)
    assert response.status_code == 200, response.text
    assert (
        response.json()["result_receipt"]["code"] == "completion_role_prompt_required"
    )
    assert response.json()["candidate"]["status"] == "failed"


async def test_oversized_context_retires_attempt_without_needing_to_assemble_recovery_status(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    prompt = await f.db.scalar(
        select(AgentPromptConfig).where(AgentPromptConfig.slug == "operator-assessment")
    )
    prompt.content = "a" * (257 * 1024)
    await f.db.flush()
    response = await acknowledge(agent_client, f, work)
    assert response.status_code == 200, response.text
    assert response.json()["result_receipt"]["code"] == "completion_context_too_large"
    assert response.json()["candidate"]["status"] == "failed"


async def test_expired_old_lease_reports_usage_without_disturbing_new_claim(
    agent_client, completion_fixture
):
    from datetime import timedelta
    from app.services.completion import naive_now

    f = completion_fixture
    work = await _claim(agent_client, f)
    old = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    old.expires_at = naive_now() - timedelta(seconds=1)
    await f.db.flush()
    successor = await claim(agent_client, f)
    response = await acknowledge(
        agent_client, f, work, {**result(work), "cost_usd": 0.42}
    )
    assert response.status_code == 200, response.text
    assert response.json()["result_receipt"]["retryable"] is False
    assert response.json()["candidate"]["status"] == "awaiting_review"
    active = await f.db.get(CompletionAttempt, uuid.UUID(successor["attempt_id"]))
    assert active.status == "claimed"
    execution = await f.db.get(AgentExecution, uuid.UUID(work["execution_id"]))
    assert execution.cost_usd == 0.42


async def test_policy_invalidated_candidate_records_rejection_without_reactivating_source(
    client, agent_client, completion_fixture
):
    from tests.test_postmerge_acceptance import policy

    f = completion_fixture
    work = await _claim(agent_client, f)
    changed = await client.put(
        f"{f.url}/policy", json={"policy": policy(auto_complete=False)}
    )
    assert changed.status_code == 200
    response = await acknowledge(
        agent_client, f, work, {**result(work), "cost_usd": 0.42}
    )
    assert response.status_code == 200, response.text
    assert response.json()["result_receipt"]["code"] == "completion_candidate_stale"
    assert response.json()["result_receipt"]["retryable"] is False
    assert response.json()["candidate"]["status"] == "stale"
    assert await claim(agent_client, f) is None


async def test_retry_does_not_retire_unreported_live_attempt(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    for _ in range(2):
        response = await client.post(f"{f.url}/cards/{f.card.id}/retry")
        assert response.status_code == 200
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    assert attempt.status == "claimed"
    assert await claim(agent_client, f) is None
