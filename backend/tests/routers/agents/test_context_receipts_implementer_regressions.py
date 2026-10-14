# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Implementer-authored A1 regressions beyond the frozen independent contract.

Each case pins an edge the frozen suite leaves open; they need independent
review like any implementer test."""

import re
import uuid

import pytest
from sqlalchemy import delete, event, func, select

from app.models.agents.execution import AgentExecution
from app.models.kanban.board import Board
from app.models.kanban.card import Card
from tests.routers.agents.context_receipts_support import (
    _receipt_case_fixture,  # noqa: F401
)

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def _patch(case, execution, **body):
    response = await case.http.patch(
        f"/api/agents/{case.agent_id}/executions/{execution['id']}",
        json=body, headers=case.headers["agent"],
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_telemetry_status_after_terminal_does_not_reopen_preparation(receipt_case):
    # Existing telemetry lets failed heal to completed, and does not forbid a
    # later non-terminal status write. Neither may mint a new dispatch receipt.
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    await _patch(case, execution, status="failed")
    await _patch(case, execution, status="completed")
    revived = await _patch(case, execution, status="running")
    assert revived["status"] == "running" and revived["completed_at"] is not None
    denied = await case.prepare(execution, assignment)
    assert denied.status_code == 409, denied.text
    assert denied.json()["error_code"] == "execution_not_active"
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 409 and refresh.json()["error_code"] == "execution_not_active"


async def test_deleted_bound_card_reports_unavailable_context(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    async with case.factory() as db:
        await db.execute(delete(Card).where(Card.id == uuid.UUID(case.card_id)))
        await db.commit()
    refresh = await case.http.get(case.execution_path(execution["id"]) + "/context",
                                 headers=case.headers["agent"])
    assert refresh.status_code == 409, refresh.text
    assert refresh.json()["error_code"] == "execution_context_unavailable"
    denied = await case.prepare(execution, assignment)
    assert denied.status_code == 409
    assert denied.json()["error_code"] == "execution_context_unavailable"


async def test_another_agent_cannot_replay_a_promoted_hold(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    await case.start(assignment)
    response = await case.http.post(f"/api/agents/{case.other_agent_id}/executions",
                                    json=case.start_payload(assignment),
                                    headers=case.headers["other_agent"])
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "reservation_not_found"
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 1


async def test_hold_promotion_requires_the_exact_board(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    payload = case.start_payload(assignment)
    payload.pop("board_id")
    response = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                    json=payload, headers=case.headers["agent"])
    assert response.status_code == 404, response.text
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 0


@pytest.mark.parametrize("query", ["limit=0", "limit=201", "offset=-1"])
async def test_receipt_history_page_bounds_are_enforced(receipt_case, query):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    response = await case.http.get(
        case.execution_path(execution["id"]) + f"/context-receipts?{query}",
        headers=case.headers["recipient"],
    )
    assert response.status_code == 422, response.text


async def test_malformed_claimed_revision_is_rejected_without_a_receipt(receipt_case):
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    payload = case.receipt_payload(assignment)
    payload["context_revision"] = assignment["context_revision"].upper()
    response = await case.http.post(case.execution_path(execution["id"]) + "/context-receipts",
                                    json=payload, headers=case.headers["agent"])
    assert response.status_code == 422, response.text
    listed = await case.http.get(case.execution_path(execution["id"]) + "/context-receipts",
                                headers=case.headers["recipient"])
    assert listed.headers["X-Total-Count"] == "0"


@pytest.mark.parametrize("field", ["role", "card_id", "board_id"])
async def test_reusing_a_promoted_hold_for_another_tuple_is_opaque_not_a_conflict(receipt_case, field):
    # Found by the frozen PostgreSQL race (tuple mismatch arriving after the
    # winner committed): a mismatched hold identity must answer the same 404
    # whether or not the hold was already promoted, never the 409 that an
    # exact-tuple payload difference gets.
    case = receipt_case
    assignment = await case.assignment()
    await case.start(assignment)
    if field == "role":
        changes = {"role": "another_arbitrary_role"}
    elif field == "card_id":
        changes = {"card_id": case.other_card_id}
    else:
        # A real board in the same workspace, so board tenancy passes and only
        # the promoted hold's identity can refuse it.
        async with case.factory() as db:
            source = await db.get(Board, uuid.UUID(case.board_id))
            other = Board(workspace_id=source.workspace_id, name="Sibling", slug="sibling",
                          created_by=source.created_by)
            db.add(other)
            await db.commit()
            changes = {"board_id": str(other.id)}
    response = await case.http.post(f"/api/agents/{case.agent_id}/executions",
                                    json=case.start_payload(assignment, **changes),
                                    headers=case.headers["agent"])
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "reservation_not_found"
    async with case.factory() as db:
        assert await db.scalar(select(func.count()).select_from(AgentExecution)) == 1


async def test_history_summary_page_never_selects_prompt_bodies_or_manifest(receipt_case, db_engine):
    # Omitting fields from the JSON is not enough: a page of up to 200 rows
    # must not pull every prompt, system prompt and manifest from the database.
    case = receipt_case
    assignment = await case.assignment()
    execution = await case.start(assignment)
    for n in range(2):
        response = await case.prepare(execution, assignment, prompt=f"Large prompt {n} " * 50)
        assert response.status_code == 201, response.text
    statements: list[str] = []

    def capture(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(db_engine.sync_engine, "before_cursor_execute", capture)
    try:
        listed = await case.http.get(case.execution_path(execution["id"]) + "/context-receipts",
                                    headers=case.headers["recipient"])
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", capture)
    assert listed.status_code == 200 and len(listed.json()) == 2
    receipt_reads = [s for s in statements if "FROM execution_context_receipts" in s]
    assert receipt_reads, statements
    heavy = re.compile(r"\bexecution_context_receipts\.(input_prompt|system_prompt|context_manifest)\b")
    for statement in receipt_reads:
        selected = statement.split("FROM execution_context_receipts")[0]
        assert not heavy.search(selected), statement
