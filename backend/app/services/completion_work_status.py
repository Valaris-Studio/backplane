# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re

from app.repositories.merge_queue import MergeQueueRepository
from app.schemas.completion import decode_work_cursor, encode_work_cursor
from app.services.git.redaction import redact_url_credentials


def safe_summary(value):
    value = redact_url_credentials(value or "")
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(
        r"(?:github_pat_|gh[pousr]_|vlr_)[A-Za-z0-9_]{8,}", "[redacted]", value
    )
    return " ".join(
        "".join(c for c in value if c.isprintable() or c.isspace()).split()
    )[:1024]


async def read_work_status(service, board, *, cursor=None, limit=100):
    from app.services.completion import digest, naive_now

    invalid_ids = set()
    counts = await service.work_counts(board, invalid_candidate_ids=invalid_ids)
    page = await service.repo.workflow_page(
        board.id,
        cursor=decode_work_cursor(cursor) if cursor else None,
        limit=limit,
        invalid_candidate_ids=invalid_ids,
    )
    more = len(page) > limit
    page = page[:limit]
    attempts = await service.repo.latest_attempts([item.id for item, _ in page])
    workflows = []
    now = naive_now()
    for candidate, _ in page:
        card = await service.policy_service.repo.card(candidate.card_id, board.id)
        current = (
            candidate.is_current
            and card is not None
            and await service.current_candidate(board, card, refresh=False)
        )
        phase = candidate.status if current else "stale"
        attempt = attempts.get(candidate.id)
        lease = None
        if attempt:
            lease_state = "closed"
            if attempt.status == "claimed":
                lease_state = (
                    "active"
                    if attempt.expires_at.replace(tzinfo=None) > now
                    else "expired"
                )
            lease = {
                "id": attempt.id,
                "status": attempt.status,
                "kind": attempt.kind,
                "role": attempt.role,
                "provider": attempt.provider,
                "model": attempt.model,
                "expires_at": attempt.expires_at,
                "lease_state": lease_state,
            }
        failure = None
        summary = candidate.summary or ""
        if phase == "stale":
            action = "inspect_completion"
            summary = "Completion configuration or source metadata changed; inspect before resubmitting."
        elif phase == "failed":
            receipt = (attempt.result or {}).get("receipt") if attempt else None
            failure = {
                "code": receipt.get("code", "completion_failed")
                if receipt
                else "completion_failed",
                "retryable": receipt.get("retryable", True) if receipt else True,
            }
            action = (
                "retry_completion" if failure["retryable"] else "inspect_completion"
            )
            from app.services.completion_rework import review_rework

            review_failure, rework = await review_rework(service, candidate)
            if review_failure is not None:
                action = (
                    "rework_completion"
                    if rework is None
                    else "wait_for_rework"
                    if await service.repo.active_rework(candidate, now)
                    else "inspect_completion"
                )
            if receipt and attempt.result.get("summary"):
                summary = attempt.result["summary"]
        elif phase in {"awaiting_review", "awaiting_validation"}:
            action = (
                "wait_for_rework"
                if await service.repo.active_rework(candidate, now)
                else "wait_for_lease"
                if lease and lease["lease_state"] == "active"
                else "claim_completion"
            )
        elif phase == "awaiting_merge":
            if candidate.policy.get("landing_actor") == "human":
                action = "human_landing"
            else:
                queue = await MergeQueueRepository(service.db).get_by_card_id(
                    candidate.card_id
                )
                if queue and queue.state in {
                    "failed",
                    "conflict",
                    "blocked_pending_consolidation",
                }:
                    action = "inspect_merge_queue"
                    failure = {"code": "merge_queue_" + queue.state, "retryable": False}
                    summary = queue.error_message or "Merge queue requires attention."
                elif queue and queue.state in {"queued", "merging", "merged"}:
                    action = "wait_for_merge"
                else:
                    action = "land_completion"
        else:
            action = "none" if phase == "accepted" else "inspect_completion"
        workflows.append(
            {
                "card_id": candidate.card_id,
                "candidate_id": candidate.id,
                "phase": phase,
                "source_sha": candidate.source_sha,
                "merge_sha": candidate.merge_sha,
                "policy_hash": candidate.policy_hash,
                "attempt": lease,
                "failure": failure,
                "next_action": action,
                "summary": safe_summary(summary),
            }
        )
    response = {
        **counts,
        "workflows": workflows,
        "next_cursor": encode_work_cursor(page[-1][1], page[-1][0].card_id)
        if more
        else None,
    }
    return {**response, "revision": digest(response)}
