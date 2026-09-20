# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from unittest.mock import AsyncMock, patch
import uuid

import pytest

from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.completion import CompletionAttempt
from tests.test_postmerge_acceptance import (
    HEAD,
    MERGED,
    acknowledge,
    claim,
    completion_fixture,
    result,
    status,
    submit,
)

__all__ = ["completion_fixture"]
pytestmark = pytest.mark.slow

FINDING = "src/check.py:42: acceptance evidence omits the configured smoke check."


async def fail_review(agent_client, f):
    candidate = await submit(agent_client, f)
    review = await claim(agent_client, f)
    rejected = await acknowledge(
        agent_client, f, review, {**result(review, "failed"), "summary": FINDING}
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["candidate"]["status"] == "failed"
    return candidate, review


async def source_execution(f):
    execution = AgentExecution(
        agent_id=f.execution.agent_id,
        workspace_id=f.board.workspace_id,
        board_id=f.board.id,
        action="loop_iteration",
        status=ExecutionStatus.running,
        cards_affected=[],
        provider="codex-cli",
        model="fixture-builder",
    )
    f.db.add(execution)
    await f.db.flush()
    return execution


def rework_payload(candidate, review, execution):
    return {
        "candidate_id": candidate["id"],
        "failed_attempt_id": review["attempt_id"],
        "source_execution_id": str(execution.id),
    }


async def test_failed_review_exposes_rework_without_dropping_outstanding_work(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        candidate, review = await fail_review(agent_client, f)
        response = await client.get(f"{f.url}/work")
        assert response.status_code == 200, response.text
        work = response.json()
        assert work["failed_count"] == 1
        workflow = work["workflows"][0]
        assert workflow["candidate_id"] == candidate["id"]
        assert workflow["phase"] == "failed"
        assert workflow["summary"] == FINDING
        assert workflow["attempt"]["id"] == review["attempt_id"]
        assert workflow["next_action"] == "rework_completion"
        assert work["rework_count"] == 1
        await f.db.refresh(f.card)
        assert f.card.column_id != f.done.id


async def test_review_rework_is_durable_idempotent_and_bound_to_one_source_execution(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        candidate, review = await fail_review(agent_client, f)
        execution = await source_execution(f)
        payload = rework_payload(candidate, review, execution)
        response = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework", json=payload
        )
        assert response.status_code == 200, response.text
        work = response.json()["work"]
        assert work["execution_id"] == str(execution.id)
        assert work["candidate_id"] == candidate["id"]
        assert work["failed_attempt_id"] == review["attempt_id"]
        assert work["card_id"] == str(f.card.id)
        for mandatory in (FINDING, candidate["id"], HEAD, f.card.pr_url):
            assert mandatory in work["context"]
        await f.db.refresh(execution)
        assert str(f.card.id) in execution.cards_affected
        duplicate = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework", json=payload
        )
        assert duplicate.status_code == 200, duplicate.text
        assert duplicate.json() == response.json()
        other_execution = await source_execution(f)
        duplicate = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework",
            json=rework_payload(candidate, review, other_execution),
        )
        assert duplicate.status_code == 200, duplicate.text
        assert duplicate.json()["work"] is None
        current = (await client.get(f"{f.url}/work")).json()
        assert current["failed_count"] == 1
        assert current["rework_count"] == 0
        assert current["workflows"][0]["next_action"] == "wait_for_rework"
        execution.status = ExecutionStatus.failed
        await f.db.flush()
        exhausted = (await client.get(f"{f.url}/work")).json()
        assert exhausted["workflows"][0]["next_action"] == "inspect_completion"
        assert exhausted["rework_count"] == 0
        replay = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework", json=payload
        )
        assert replay.status_code == 200, replay.text
        assert replay.json() == response.json()
        assert FINDING in current["workflows"][0]["summary"]
        failed = await f.db.get(CompletionAttempt, uuid.UUID(review["attempt_id"]))
        assert failed.status == "failed"
        assert failed.result["summary"] == FINDING


async def test_rework_same_revision_returns_to_fresh_independent_review_and_exact_validation(
    client, agent_client, completion_fixture
):
    from app.services.completion import CompletionService

    f = completion_fixture
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *args, **kwargs: current),
    ):
        candidate, review = await fail_review(agent_client, f)
        execution = await source_execution(f)
        dispatched = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework",
            json=rework_payload(candidate, review, execution),
        )
        assert dispatched.status_code == 200, dispatched.text
        execution.status = ExecutionStatus.completed
        execution.output_summary = "Corrected the missing acceptance evidence and ran the configured smoke check."
        await f.db.flush()
        retried = await agent_client.post(f"{f.url}/cards/{f.card.id}/retry")
        assert retried.status_code == 200, retried.text
        assert retried.json()["candidate"]["id"] == candidate["id"]
        fresh = await claim(agent_client, f)
        assert fresh["kind"] == "review"
        assert fresh["role"] == "custom-arbiter"
        assert fresh["attempt_id"] != review["attempt_id"]
        assert fresh["execution_id"] != str(execution.id)
        assert fresh["source_sha"] == HEAD
        assert (await acknowledge(agent_client, f, fresh)).status_code == 200
        await f.db.refresh(f.card)
        assert f.card.column_id != f.done.id
        current = status(merged=True)
        await CompletionService(f.db).record_merge(f.board, f.card, current)
        validation = await claim(agent_client, f)
        assert validation["kind"] == "validation"
        assert validation["source_sha"] == MERGED
        assert (await acknowledge(agent_client, f, validation)).status_code == 200
        await f.db.refresh(f.card)
        assert f.card.column_id == f.done.id


@pytest.mark.parametrize(
    "invalid_execution",
    [
        "completed",
        "other_board",
        "other_workspace",
        "other_runner",
        "other_card",
        "review",
    ],
)
async def test_review_rework_refuses_execution_outside_active_source_scope(
    agent_client, completion_fixture, invalid_execution
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        candidate, review = await fail_review(agent_client, f)
        execution = await source_execution(f)
        if invalid_execution == "completed":
            execution.status = ExecutionStatus.completed
        elif invalid_execution == "other_board":
            execution.board_id = None
        elif invalid_execution == "other_workspace":
            from app.models.workspace import Workspace

            other = Workspace(name="Other", slug="other", created_by=f.card.created_by)
            f.db.add(other)
            await f.db.flush()
            execution.workspace_id = other.id
        elif invalid_execution == "other_runner":
            from app.models.agents.agent import Agent, AgentType

            other = Agent(
                name="Other runner",
                agent_type=AgentType.coding,
                created_by_id=f.card.created_by,
            )
            f.db.add(other)
            await f.db.flush()
            execution.agent_id = other.id
        elif invalid_execution == "other_card":
            execution.cards_affected = [str(f.card.id), str(uuid.uuid4())]
        else:
            execution.action = "completion_review"
        await f.db.flush()
        response = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework",
            json=rework_payload(candidate, review, execution),
        )
        assert response.status_code in (404, 409), response.text
        available = (await agent_client.get(f"{f.url}/work")).json()
        assert available["rework_count"] == 1


async def test_rejected_control_plane_result_does_not_dispatch_implementation_rework(
    agent_client, completion_fixture
):
    from tests.test_completion_stale_recovery import stale_result

    f = completion_fixture
    _, _, response = await stale_result(agent_client, f)
    assert response.status_code == 200, response.text
    available = (await agent_client.get(f"{f.url}/work")).json()
    assert available["failed_count"] == 1
    assert available["rework_count"] == 0
    assert available["workflows"][0]["next_action"] == "retry_completion"


async def test_rework_fresh_head_creates_new_candidate_and_keeps_failed_review_history(
    agent_client, completion_fixture
):
    f = completion_fixture
    current = status()
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(side_effect=lambda *args, **kwargs: current),
    ):
        candidate, review = await fail_review(agent_client, f)
        execution = await source_execution(f)
        dispatched = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework",
            json=rework_payload(candidate, review, execution),
        )
        assert dispatched.status_code == 200, dispatched.text
        current = status(head="c" * 40)
        replacement = await submit(
            agent_client, f, source_execution_id=str(execution.id)
        )
        assert replacement["id"] != candidate["id"]
        assert replacement["source_sha"] == "c" * 40
        assert replacement["status"] == "awaiting_review"
        assert await claim(agent_client, f) is None
        execution.status = ExecutionStatus.completed
        await f.db.flush()
        independent = await claim(agent_client, f)
        assert independent["kind"] == "review"
        assert independent["candidate_id"] == replacement["id"]
        assert independent["execution_id"] != str(execution.id)
        failed = await f.db.get(CompletionAttempt, uuid.UUID(review["attempt_id"]))
        assert failed.status == "failed"
        assert failed.result["summary"] == FINDING


async def test_retry_waits_for_running_rework_before_claiming_independent_review(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        candidate, review = await fail_review(agent_client, f)
        execution = await source_execution(f)
        dispatched = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework",
            json=rework_payload(candidate, review, execution),
        )
        assert dispatched.status_code == 200, dispatched.text
        assert (
            await agent_client.post(f"{f.url}/cards/{f.card.id}/retry")
        ).status_code == 200
        available = (await client.get(f"{f.url}/work")).json()
        assert available["pending_count"] == 1
        assert available["actionable_count"] == 0
        assert available["workflows"][0]["next_action"] == "wait_for_rework"
        assert await claim(agent_client, f) is None
        execution.status = ExecutionStatus.completed
        await f.db.flush()
        assert (await client.get(f"{f.url}/work")).json()["actionable_count"] == 1
        assert (await claim(agent_client, f))["kind"] == "review"


async def test_execution_failure_never_dispatches_implementation_rework(
    agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        review = await claim(agent_client, f)
        response = await acknowledge(
            agent_client,
            f,
            review,
            {
                **result(review, "failed"),
                "failure_class": "execution",
                "summary": "Provider unavailable",
            },
        )
        assert response.status_code == 200, response.text
        available = (await agent_client.get(f"{f.url}/work")).json()
        assert available["failed_count"] == 1
        assert available["rework_count"] == 0
        assert available["workflows"][0]["next_action"] == "retry_completion"


async def test_evidence_review_failure_can_dispatch_source_rework(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    f.card.pr_url = None
    f.card.branch_name = None
    await f.db.flush()
    selected = await client.put(
        f"{f.url}/cards/{f.card.id}/mode", json={"completion_mode": "evidence_only"}
    )
    assert selected.status_code == 200, selected.text
    candidate = await submit(
        agent_client,
        f,
        source_sha=HEAD,
        artifacts=[
            {
                "name": "Acceptance",
                "uri": "https://example.com/artifact",
                "sha256": "d" * 64,
            }
        ],
        checks=[{"id": "smoke", "source_sha": HEAD, "exit_code": 0}],
    )
    review = await claim(agent_client, f)
    assert review["kind"] == "evidence_review"
    failed = await acknowledge(
        agent_client, f, review, {**result(review, "failed"), "summary": FINDING}
    )
    assert failed.status_code == 200, failed.text
    execution = await source_execution(f)
    recovery = await agent_client.post(
        f"{f.url}/cards/{f.card.id}/rework",
        json=rework_payload(candidate, review, execution),
    )
    assert recovery.status_code == 200, recovery.text
    assert FINDING in recovery.json()["work"]["context"]
    await f.db.refresh(f.card)
    assert f.card.column_id != f.done.id


async def test_rework_context_limit_fails_closed_without_consuming_assignment(
    agent_client, completion_fixture
):
    from app.services.completion_context import EXECUTION_CONTEXT_LIMIT

    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        candidate, review = await fail_review(agent_client, f)
        execution = await source_execution(f)
        with patch(
            "app.services.completion_rework.mandatory_completion_context",
            new=AsyncMock(return_value="x" * EXECUTION_CONTEXT_LIMIT),
        ):
            response = await agent_client.post(
                f"{f.url}/cards/{f.card.id}/rework",
                json=rework_payload(candidate, review, execution),
            )
        assert response.status_code == 409, response.text
        assert response.json()["error_code"] == "completion_context_too_large"
        assert (await agent_client.get(f"{f.url}/work")).json()["rework_count"] == 1


async def test_result_replay_preserves_pre_upgrade_hash_without_failure_class(
    agent_client, completion_fixture
):
    from app.services.completion import digest

    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        candidate, review = await fail_review(agent_client, f)
        payload = {**result(review, "failed"), "summary": FINDING}
        legacy_result = {
            key: value for key, value in payload.items() if key != "lease_token"
        }
        legacy_result.update(
            artifacts=[], tokens_used=0, cost_usd=0.0, duration_seconds=0.0
        )
        attempt = await f.db.get(CompletionAttempt, uuid.UUID(review["attempt_id"]))
        attempt.result = legacy_result
        attempt.result_hash = digest(legacy_result)
        await f.db.flush()
        replay = await acknowledge(agent_client, f, review, payload)
        assert replay.status_code == 200, replay.text
        assert replay.json()["candidate"]["id"] == candidate["id"]
        assert replay.json()["candidate"]["status"] == "failed"
        await f.db.refresh(attempt)
        assert attempt.result == legacy_result
        assert attempt.result_hash == digest(legacy_result)
        assert "failure_class" not in attempt.result


async def test_rework_execution_cannot_be_reused_for_another_failed_candidate(
    agent_client, completion_fixture
):
    from types import SimpleNamespace
    from app.models.kanban.card import Card

    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        first_candidate, first_review = await fail_review(agent_client, f)
        second_card = Card(
            board_id=f.board.id,
            column_id=f.card.column_id,
            title="Second reviewed card",
            position=2048,
            created_by=f.card.created_by,
            pr_url=f.card.pr_url,
            branch_name=f.card.branch_name,
            git_repo_slug=f.card.git_repo_slug,
        )
        f.db.add(second_card)
        await f.db.flush()
        f.execution.cards_affected = [str(f.card.id), str(second_card.id)]
        await f.db.flush()
        second = SimpleNamespace(**{**vars(f), "card": second_card})
        second_candidate, second_review = await fail_review(agent_client, second)
        execution = await source_execution(f)
        accepted = await agent_client.post(
            f"{f.url}/cards/{f.card.id}/rework",
            json=rework_payload(first_candidate, first_review, execution),
        )
        assert accepted.status_code == 200, accepted.text
        # Agent execution updates may replace cards_affected; the durable
        # assignment must still prevent this execution from being reused.
        execution.cards_affected = []
        await f.db.flush()
        reused = await agent_client.post(
            f"{f.url}/cards/{second_card.id}/rework",
            json=rework_payload(second_candidate, second_review, execution),
        )
        assert reused.status_code == 409, reused.text
        assert reused.json()["error_code"] == "completion_source_execution_invalid"
        assert (await agent_client.get(f"{f.url}/work")).json()["rework_count"] == 1
