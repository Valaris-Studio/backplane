# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from app.models.kanban.completion import CompletionAttempt
from tests.test_completion_execution_boundaries import _claim, _configure_role
from tests.test_completion_stale_recovery import change_context
from tests.test_postmerge_acceptance import acknowledge, completion_fixture

__all__ = ["completion_fixture"]


async def test_rejected_context_receipt_identifies_changed_input(
    agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    assert attempt.context_manifest
    prompt = next(
        source for source in attempt.context_manifest if source["kind"] == "prompt"
    )
    await change_context(f)
    response = await acknowledge(agent_client, f, work)
    assert response.status_code == 200, response.text
    assert {
        "kind": "prompt",
        "id": prompt["id"],
        "change": "changed",
    } in response.json()["result_receipt"]["changed_sources"]


async def test_explicit_retry_revalidates_historical_stranded_context(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    attempt.context_manifest = None  # An attempt claimed before the rolling migration.
    await change_context(f)
    response = await client.post(f"{f.url}/cards/{f.card.id}/retry")
    assert response.status_code == 200, response.text
    assert attempt.status == "rejected"
    successor = await _claim(agent_client, f)
    assert successor["attempt_id"] != work["attempt_id"]
    assert successor["candidate_id"] == work["candidate_id"]
    late = await acknowledge(agent_client, f, work)
    assert late.status_code == 200, late.text
    assert late.json()["result_receipt"]["code"] == "completion_context_changed"
    assert late.json()["candidate"]["status"] == "awaiting_review"
    assert (
        await f.db.get(CompletionAttempt, uuid.UUID(successor["attempt_id"]))
    ).status == "claimed"


async def test_explicit_retry_never_steals_healthy_attempt(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await _configure_role(f)
    work = await _claim(agent_client, f)
    response = await client.post(f"{f.url}/cards/{f.card.id}/retry")
    assert response.status_code == 200, response.text
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    assert attempt.status == "claimed"
    assert attempt.result is None
