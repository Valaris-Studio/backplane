# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from datetime import timedelta
import json

from app.exceptions import ConflictError, ResourceNotFoundError
from app.models.agents.execution import ExecutionStatus
from app.services.completion_context import (
    EXECUTION_CONTEXT_LIMIT,
    mandatory_completion_context,
)


async def review_rework(service, candidate):
    if candidate.status != "failed" or candidate.failed_kind not in {
        "review",
        "evidence_review",
    }:
        return None, None
    attempt = (await service.repo.latest_attempts([candidate.id])).get(candidate.id)
    if (
        attempt is None
        or attempt.kind != candidate.failed_kind
        or attempt.status != "failed"
        or (attempt.result or {}).get("outcome") != "failed"
        or (attempt.result or {}).get("failure_class") == "execution"
        or (attempt.result or {}).get("receipt")
    ):
        return None, None
    return attempt, await service.repo.rework_attempt(candidate.id, attempt.id)


async def dispatch_rework(service, board_id, workspace_id, actor_id, card_id, data):
    from app.services.completion import naive_now

    # The locked card serializes dispatches from different runner processes.
    board, card = await service._scope(
        board_id, workspace_id, actor_id, card_id, mutate=True, runner=True
    )
    candidate = await service.current_candidate(board, card)
    if candidate is None or candidate.id != data.candidate_id:
        raise ConflictError(
            "The failed completion candidate is no longer current",
            error_code="completion_candidate_mismatch",
        )
    execution = await service.repo.source_execution(
        data.source_execution_id, workspace_id, board_id, service._runner()
    )
    if execution is None:
        raise ResourceNotFoundError("Source execution not found for this card")
    if execution.action != "loop_iteration" or (
        execution.cards_affected and execution.cards_affected != [str(card.id)]
    ):
        raise ConflictError(
            "Recovery requires a source iteration for this card",
            error_code="completion_source_execution_invalid",
        )
    failure, prior = await review_rework(service, candidate)
    if failure is None or failure.id != data.failed_attempt_id:
        raise ConflictError(
            "The completion review is no longer eligible for implementation rework",
            error_code="completion_rework_unavailable",
        )
    if prior is not None:
        return {
            "work": prior.result["work"] if prior.execution_id == execution.id else None
        }
    if execution.status not in (ExecutionStatus.started, ExecutionStatus.running):
        raise ConflictError(
            "Recovery requires an active source iteration",
            error_code="completion_source_execution_invalid",
        )
    if await service.repo.execution_attempt(execution.id):
        raise ConflictError(
            "This source iteration already owns a recovery assignment",
            error_code="completion_source_execution_invalid",
        )
    policy = await service._policy(board)
    mandatory = await mandatory_completion_context(service.db, board, policy)
    recovery = {
        "card_id": str(card.id),
        "candidate_id": str(candidate.id),
        "failed_attempt_id": str(failure.id),
        "source_execution_id": str(execution.id),
        "source_sha": candidate.source_sha,
        "pr_url": candidate.pr_url,
        "branch": candidate.branch,
        "card_title": card.title,
        "card_description": card.description,
        "finding": (failure.result or {}).get("summary") or candidate.summary,
        "review_result": failure.result,
    }
    context = "\n\n".join(
        (
            mandatory,
            "MANDATORY COMPLETION REVIEW REWORK",
            json.dumps(recovery, sort_keys=True, default=str),
            "Work only on this assigned card. Address every review finding and record the correction and validation evidence. "
            "This assignment permits one bounded source iteration; it does not approve completion. "
            "If the PR head changes, submit_completion_candidate using this source_execution_id to obtain fresh independent review. "
            "If only evidence changes on the same source SHA, correct and record that evidence before retry_completion. "
            "Do not retry an unchanged failure, merge without authorization, move the card to Done, or release dependent work. "
            "If correction is impossible within the iteration, report the blocker for inspection.",
        )
    )
    if len(context.encode("utf-8")) > EXECUTION_CONTEXT_LIMIT:
        raise ConflictError(
            "Mandatory completion rework context exceeds the execution context limit",
            error_code="completion_context_too_large",
        )
    work = {
        "candidate_id": str(candidate.id),
        "card_id": str(card.id),
        "failed_attempt_id": str(failure.id),
        "execution_id": str(execution.id),
        "context": context,
    }
    from app.services.loop_config_validation import LOOP_CONFIG_DEFAULTS

    timeout = (board.loop_config or {}).get(
        "iteration_timeout_seconds", LOOP_CONFIG_DEFAULTS["iteration_timeout_seconds"]
    )
    await service.repo.create_attempt(
        candidate_id=candidate.id,
        workspace_id=workspace_id,
        board_id=board_id,
        execution_id=execution.id,
        agent_id=service._runner(),
        kind="rework",
        role=execution.role or "",
        provider=execution.provider or "",
        model=execution.model or "",
        source_sha=candidate.source_sha,
        status="dispatched",
        lease_hash="",
        expires_at=naive_now() + timedelta(seconds=timeout + 600),
        result={"failed_attempt_id": str(failure.id), "work": work},
    )
    await service.repo.update(
        execution,
        cards_affected=[str(card.id)],
        input_summary=f"Implementation rework for failed completion candidate {candidate.id}",
    )
    await service._publish(candidate)
    return {"work": work}
