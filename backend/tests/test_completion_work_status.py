# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import timedelta
import uuid

import pytest
from sqlalchemy import event, select

from app.models.kanban.column import Column, ColumnType
from app.models.kanban.completion import CompletionAttempt, CompletionCandidate
from app.services.completion import naive_now
from tests.test_completion_execution_boundaries import _claim
from tests.test_completion_stale_recovery import stale_result
from tests.test_postmerge_acceptance import completion_fixture

__all__ = ["completion_fixture"]
pytestmark = pytest.mark.slow


async def read_work(client, f):
    response = await client.get(f"{f.url}/work")
    assert response.status_code == 200, response.text
    return response.json()


async def test_work_status_preserves_claim_identity_for_read_only_restart(
    client, agent_client, completion_fixture, db_engine
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    statements = []

    def record_statement(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().split()[0].upper() in {"INSERT", "UPDATE", "DELETE"}:
            statements.append(statement.split()[0])

    event.listen(db_engine.sync_engine, "before_cursor_execute", record_statement)
    try:
        first = await read_work(client, f)
        second = await read_work(client, f)
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", record_statement)
    assert statements == []
    assert first == second
    assert len(first["revision"]) == 64
    assert first["pending_count"] == 1 and first["actionable_count"] == 0
    workflow = first["workflows"][0]
    assert workflow["card_id"] == str(f.card.id)
    assert workflow["candidate_id"] == work["candidate_id"]
    assert workflow["phase"] == "awaiting_review"
    assert workflow["source_sha"] == work["source_sha"]
    assert workflow["next_action"] == "wait_for_lease"
    assert workflow["attempt"]["id"] == work["attempt_id"]
    assert workflow["attempt"]["lease_state"] == "active"
    assert workflow["attempt"]["role"] == work["role"]
    assert workflow["attempt"]["provider"] == work["provider"]
    assert workflow["attempt"]["model"] == work["model"]
    assert "lease_token" not in str(first) and "lease_hash" not in str(first)
    assert work["lease_token"] not in str(first)
    assert "context" not in workflow["attempt"]


async def test_work_status_exposes_durable_rejection_until_explicit_retry(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work, _, rejected = await stale_result(agent_client, f)
    assert rejected.status_code == 200
    before = await read_work(client, f)
    workflow = before["workflows"][0]
    assert before["failed_count"] == 1 and before["actionable_count"] == 0
    assert workflow["candidate_id"] == work["candidate_id"]
    assert workflow["phase"] == "failed"
    assert workflow["attempt"]["id"] == work["attempt_id"]
    assert workflow["attempt"]["lease_state"] == "closed"
    assert workflow["failure"] == {
        "code": "completion_context_changed",
        "retryable": True,
    }
    assert workflow["next_action"] == "retry_completion"
    assert await read_work(client, f) == before
    retry = await client.post(f"{f.url}/cards/{f.card.id}/retry")
    assert retry.status_code == 200
    after = await read_work(client, f)
    assert after["revision"] != before["revision"]
    assert after["workflows"][0]["candidate_id"] == work["candidate_id"]
    assert after["workflows"][0]["next_action"] == "claim_completion"
    assert after["actionable_count"] == 1


async def test_work_status_expired_lease_is_visible_without_retiring_it(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    before = await read_work(client, f)
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    attempt.expires_at = naive_now() - timedelta(seconds=1)
    await f.db.flush()
    after = await read_work(client, f)
    assert after["revision"] != before["revision"]
    assert after["workflows"][0]["attempt"]["lease_state"] == "expired"
    assert after["workflows"][0]["next_action"] == "claim_completion"
    assert after["actionable_count"] == 1
    await f.db.refresh(attempt)
    assert attempt.status == "claimed" and attempt.completed_at is None


async def test_work_status_keeps_completion_work_independent_of_blocked_column(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    column = await f.db.get(Column, f.card.column_id)
    column.column_type = ColumnType.blocked
    await f.db.flush()
    response = await read_work(client, f)
    assert response["pending_count"] == 1
    assert response["workflows"][0]["candidate_id"] == work["candidate_id"]
    assert response["workflows"][0]["next_action"] == "wait_for_lease"


async def test_work_inspection_reports_stale_metadata_without_mutating_candidate(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    f.card.title += " updated after claim"
    await f.db.flush()
    response = await read_work(client, f)
    candidate = await f.db.get(CompletionCandidate, uuid.UUID(work["candidate_id"]))
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    await f.db.refresh(candidate)
    await f.db.refresh(attempt)
    assert candidate.is_current and candidate.status == "awaiting_review"
    assert attempt.status == "claimed"
    assert response["workflows"][0]["phase"] == "stale"
    assert response["workflows"][0]["next_action"] == "inspect_completion"
    assert response["actionable_count"] == 0


async def test_work_status_unknown_board_cannot_reveal_workflows(
    client, test_workspace
):
    response = await client.get(
        f"/api/workspaces/{test_workspace.slug}/boards/{uuid.uuid4()}/completion/work"
    )
    assert response.status_code == 404
    assert "workflows" not in response.json()


async def test_work_status_keeps_accepted_revision_visible_after_card_done(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    candidate = await f.db.get(CompletionCandidate, uuid.UUID(work["candidate_id"]))
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    candidate.status = "accepted"
    candidate.merge_sha = "b" * 40
    candidate.accepted_at = naive_now()
    attempt.status = "passed"
    attempt.completed_at = naive_now()
    f.card.column_id = f.done.id
    await f.db.flush()
    response = await read_work(client, f)
    assert response["pending_count"] == response["actionable_count"] == 0
    workflow = response["workflows"][0]
    assert workflow["phase"] == "accepted"
    assert workflow["next_action"] == "none"
    assert workflow["merge_sha"] == "b" * 40


async def test_work_status_failed_merge_queue_requires_inspection_not_passive_wait(
    client, agent_client, completion_fixture
):
    from app.models.agents.merge_queue import MergeQueueEntry

    f = completion_fixture
    work = await _claim(agent_client, f)
    candidate = await f.db.get(CompletionCandidate, uuid.UUID(work["candidate_id"]))
    attempt = await f.db.get(CompletionAttempt, uuid.UUID(work["attempt_id"]))
    candidate.status = "awaiting_merge"
    candidate.review_passed = True
    attempt.status = "passed"
    attempt.completed_at = naive_now()
    queue = MergeQueueEntry(
        repo_id=f.repo.id,
        integration_branch="main",
        card_id=f.card.id,
        pr_url=f.card.pr_url,
        pr_branch=f.card.branch_name,
        workspace_id=f.board.workspace_id,
        state="failed",
        error_message="Cannot land",
    )
    f.db.add(queue)
    await f.db.flush()
    response = await read_work(client, f)
    workflow = response["workflows"][0]
    assert workflow["phase"] == "awaiting_merge"
    assert workflow["next_action"] == "inspect_merge_queue"
    assert workflow["failure"]["code"] == "merge_queue_failed"
    assert workflow["summary"]
    await f.db.refresh(queue)
    assert queue.state == "failed"


async def test_loop_readiness_reports_explicit_blocked_separately_from_dependencies(
    client, completion_fixture
):
    f = completion_fixture
    column = await f.db.get(Column, f.card.column_id)
    column.column_type = ColumnType.blocked
    await f.db.flush()
    response = await client.get(
        f"/api/workspaces/default/boards/{f.board.id}/loop/readiness"
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["blocked_count"] == 0
    assert data["explicitly_blocked_count"] == 1
    assert data["explicitly_blocked_card_ids"] == [str(f.card.id)]
    assert data["actionable"] is False


async def test_work_status_pages_latest_candidate_per_card_without_hiding_counts(
    client, agent_client, completion_fixture
):
    from app.models.kanban.card import Card
    from app.services.completion import card_fingerprint

    f = completion_fixture
    work = await _claim(agent_client, f)
    original = await f.db.get(CompletionCandidate, uuid.UUID(work["candidate_id"]))
    card = Card(
        board_id=f.board.id,
        column_id=f.card.column_id,
        title="Another candidate",
        created_by=f.card.created_by,
        position=2048,
        pr_url=f.card.pr_url,
        git_repo_slug=f.card.git_repo_slug,
        branch_name=f.card.branch_name,
        completion_mode=f.card.completion_mode,
    )
    f.db.add(card)
    await f.db.flush()
    values = {
        field.name: getattr(original, field.name)
        for field in CompletionCandidate.__table__.columns
        if field.name not in {"id", "created_at", "updated_at", "card_id", "card_hash"}
    }
    f.db.add(
        CompletionCandidate(**values, card_id=card.id, card_hash=card_fingerprint(card))
    )
    await f.db.flush()
    first = await client.get(f"{f.url}/work", params={"limit": 1})
    assert first.status_code == 200
    page = first.json()
    assert page["pending_count"] == 2 and page["actionable_count"] == 1
    assert len(page["workflows"]) == 1 and page["next_cursor"]
    second = await client.get(
        f"{f.url}/work", params={"limit": 1, "cursor": page["next_cursor"]}
    )
    assert second.status_code == 200
    assert second.json()["pending_count"] == 2
    assert len(second.json()["workflows"]) == 1
    assert second.json()["next_cursor"] is None
    assert {
        page["workflows"][0]["card_id"],
        second.json()["workflows"][0]["card_id"],
    } == {str(card.id), str(f.card.id)}
    invalid = await client.get(f"{f.url}/work", params={"limit": 101})
    assert invalid.status_code == 422


async def test_work_status_failure_summary_is_bounded_and_terminal_safe(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    work = await _claim(agent_client, f)
    candidate = await f.db.get(CompletionCandidate, uuid.UUID(work["candidate_id"]))
    candidate.status = "failed"
    candidate.failed_kind = "review"
    candidate.summary = (
        "Review found missing checks\nhttps://secret:password@example.com/path\x1b[31m "
        + "x" * 2000
    )
    await f.db.flush()
    response = await read_work(client, f)
    summary = response["workflows"][0]["summary"]
    assert "Review found missing checks" in summary
    assert "secret:password" not in summary and "\x1b" not in summary
    assert len(summary) <= 1024


@pytest.mark.parametrize("attention", ["failed", "stale"])
async def test_work_status_prioritizes_attention_ahead_of_100_accepted_cards(
    client, agent_client, completion_fixture, attention
):
    from app.models.kanban.card import Card
    from app.services.completion import card_fingerprint

    f = completion_fixture
    work = await _claim(agent_client, f)
    original = await f.db.get(CompletionCandidate, uuid.UUID(work["candidate_id"]))
    assert f.card.id.int > 100
    values = {
        field.name: getattr(original, field.name)
        for field in CompletionCandidate.__table__.columns
        if field.name
        not in {"id", "created_at", "updated_at", "card_id", "card_hash", "status"}
    }
    expected = {str(f.card.id)}
    for index in range(1, 101):
        card = Card(
            id=uuid.UUID(int=index),
            board_id=f.board.id,
            column_id=f.done.id,
            title=f"Accepted {index}",
            created_by=f.card.created_by,
            position=index * 1024,
            pr_url=f.card.pr_url,
            git_repo_slug=f.card.git_repo_slug,
            branch_name=f.card.branch_name,
            completion_mode=f.card.completion_mode,
            description="",
        )
        f.db.add(card)
        f.db.add(
            CompletionCandidate(
                **values,
                card_id=card.id,
                card_hash=card_fingerprint(card),
                status="accepted",
            )
        )
        expected.add(str(card.id))
    if attention == "failed":
        original.status = "failed"
        original.failed_kind = "review"
    else:
        # A read-only fingerprint mismatch is stale even before a mutation
        # writes status='stale'; it also deserves attention before history.
        original.status = "accepted"
        f.card.title += " changed after acceptance"
    await f.db.flush()
    first = await read_work(client, f)
    assert len(first["workflows"]) == 100
    assert first["workflows"][0]["card_id"] == str(f.card.id)
    assert first["workflows"][0]["phase"] == attention
    assert first["workflows"][0]["next_action"] == (
        "retry_completion" if attention == "failed" else "inspect_completion"
    )
    assert first["failed_count"] == (1 if attention == "failed" else 0)
    assert first["next_cursor"]
    single = await client.get(f"{f.url}/work", params={"limit": 1})
    assert single.status_code == 200
    across_priority = await client.get(
        f"{f.url}/work", params={"limit": 1, "cursor": single.json()["next_cursor"]}
    )
    assert across_priority.status_code == 200
    assert across_priority.json()["workflows"][0]["card_id"] == str(uuid.UUID(int=1))
    second = await client.get(f"{f.url}/work", params={"cursor": first["next_cursor"]})
    assert second.status_code == 200, second.text
    assert second.json()["next_cursor"] is None
    rows = first["workflows"] + second.json()["workflows"]
    assert len(rows) == 101
    assert {row["card_id"] for row in rows} == expected
    await f.db.refresh(original)
    assert original.status == ("failed" if attention == "failed" else "accepted")
    for index, phase in [(1, "awaiting_review"), (2, "awaiting_merge")]:
        pending = await f.db.scalar(
            select(CompletionCandidate).where(
                CompletionCandidate.card_id == uuid.UUID(int=index)
            )
        )
        pending.status = phase
    await f.db.flush()
    prioritized = await client.get(f"{f.url}/work", params={"limit": 3})
    assert prioritized.status_code == 200
    assert [row["phase"] for row in prioritized.json()["workflows"]] == [
        attention,
        "awaiting_review",
        "awaiting_merge",
    ]
    assert prioritized.json()["pending_count"] == 2


@pytest.mark.parametrize(
    "cursor",
    [
        "not-a-cursor",
        "3:00000000-0000-0000-0000-000000000001",
        "0:bad",
        "0:" + "x" * 500,
        "MTozOjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMQ",  # unsupported priority
        "MjowOjAwMDAwMDAwLTAwMDAtMDAwMC0wMDAwLTAwMDAwMDAwMDAwMQ",  # unsupported version
    ],
)
async def test_work_status_rejects_malformed_priority_cursor(
    client, completion_fixture, cursor
):
    response = await client.get(
        f"{completion_fixture.url}/work", params={"cursor": cursor}
    )
    assert response.status_code == 422
