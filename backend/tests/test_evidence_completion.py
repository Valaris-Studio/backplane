# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from unittest.mock import AsyncMock, patch

import pytest

from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.kanban.completion import CompletionAttempt

from tests.test_postmerge_acceptance import (
    HEAD,
    acknowledge,
    claim,
    completion_fixture,
    result,
    status,
    submit,
)

__all__ = ["completion_fixture"]

EVIDENCE = {
    "source_sha": HEAD,
    "artifacts": [
        {
            "name": "release-package",
            "uri": "artifact://fixture/package.zip",
            "sha256": "d" * 64,
        }
    ],
    "checks": [
        {
            "id": "package-smoke",
            "source_sha": HEAD,
            "exit_code": 0,
            "output": "Fixture package opened",
        }
    ],
}


async def test_evidence_mode_is_operator_owned_and_independently_approved(
    client,
    agent_client,
    completion_fixture,
):
    f = completion_fixture
    mode_url = f"{f.url}/cards/{f.card.id}/mode"
    denied = await agent_client.put(mode_url, json={"completion_mode": "evidence_only"})
    assert denied.status_code == 403, denied.text
    selected = await client.put(mode_url, json={"completion_mode": "evidence_only"})
    assert selected.status_code == 200, selected.text
    f.card.pr_url = None
    f.card.branch_name = None
    await f.db.flush()
    candidate = await submit(agent_client, f, **EVIDENCE)
    assert candidate["status"] == "awaiting_review"
    assert candidate["pr_url"] is None
    review = await claim(agent_client, f)
    assert review["kind"] == "evidence_review"
    assert review["source_sha"] == HEAD
    assert "release-package" in review["context"]
    assert review["lease_token"] not in review["context"]
    accepted = await acknowledge(agent_client, f, review)
    assert accepted.status_code == 200, accepted.text
    await f.db.refresh(f.card)
    assert f.card.column_id == f.done.id


async def test_artifacts_do_not_bypass_ordinary_source_requirement(
    agent_client, completion_fixture
):
    f = completion_fixture
    f.card.pr_url = None
    await f.db.flush()
    response = await agent_client.post(
        f"{f.url}/cards/{f.card.id}/submit",
        json={
            "source_execution_id": str(f.execution.id),
            **EVIDENCE,
        },
    )
    assert response.status_code in (409, 422), response.text
    await f.db.refresh(f.card)
    assert f.card.column_id != f.done.id


@pytest.mark.parametrize("field", ["artifacts", "checks", "source_sha"])
async def test_evidence_requires_exact_provenance(
    client, agent_client, completion_fixture, field
):
    f = completion_fixture
    selected = await client.put(
        f"{f.url}/cards/{f.card.id}/mode", json={"completion_mode": "evidence_only"}
    )
    assert selected.status_code == 200, selected.text
    payload = {"source_execution_id": str(f.execution.id), **EVIDENCE}
    del payload[field]
    response = await agent_client.post(
        f"{f.url}/cards/{f.card.id}/submit", json=payload
    )
    assert response.status_code in (409, 422), response.text


async def test_mode_change_invalidates_an_outstanding_source_review(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, f)
        source_review = await claim(agent_client, f)
        selected = await client.put(
            f"{f.url}/cards/{f.card.id}/mode", json={"completion_mode": "evidence_only"}
        )
        assert selected.status_code == 200, selected.text
        old = await acknowledge(agent_client, f, source_review, result(source_review))
        assert old.status_code == 200, old.text
        receipt = old.json()["result_receipt"]
        assert receipt == {
            "attempt_id": source_review["attempt_id"],
            "status": "rejected",
            "code": "completion_candidate_stale",
            "retryable": False,
            "next_action": "inspect_completion",
        }
        assert old.json()["candidate"]["status"] == "stale"
        assert old.json()["candidate"]["review_passed"] is False
        attempt = await f.db.get(
            CompletionAttempt, uuid.UUID(source_review["attempt_id"])
        )
        execution = await f.db.get(
            AgentExecution, uuid.UUID(source_review["execution_id"])
        )
        assert attempt.status == "rejected"
        assert attempt.completed_at is not None
        assert attempt.result["receipt"] == receipt
        assert execution.status == ExecutionStatus.aborted
        await f.db.refresh(f.card)
        assert f.card.column_id != f.done.id
        replay = await acknowledge(agent_client, f, source_review, result(source_review))
        assert replay.status_code == 200, replay.text
        assert replay.json()["result_receipt"] == receipt


async def test_claim_injects_mandatory_context_and_records_execution_metrics(
    client, agent_client, completion_fixture
):
    from app.models.agents.execution import AgentExecution

    f = completion_fixture
    await client.put(
        f"{f.url}/cards/{f.card.id}/mode", json={"completion_mode": "evidence_only"}
    )
    f.card.pr_url = None
    f.card.branch_name = None
    await f.db.flush()
    await submit(agent_client, f, **EVIDENCE)
    with patch(
        "app.services.completion_context.mandatory_completion_context",
        new=AsyncMock(return_value="REQUIRED BOARD EVIDENCE"),
    ):
        work = await claim(agent_client, f)
        assert "REQUIRED BOARD EVIDENCE" in work["context"]
        payload = {
            **result(work),
            "tokens_used": 2345,
            "cost_usd": 0.75,
            "duration_seconds": 32.5,
        }
        response = await acknowledge(agent_client, f, work, payload)
    assert response.status_code == 200, response.text
    execution = await f.db.get(AgentExecution, uuid.UUID(work["execution_id"]))
    assert execution.tokens_used == 2345
    assert execution.cost_usd == 0.75
    assert execution.duration_seconds == 32.5
