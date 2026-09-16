# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Backend-owned merge queue (PAR-2).

Replaces runner-side mergeGate. Reviewer-approve enqueues; a backend worker
pops and merges via an injectable executor. The queue mechanics here are
fully testable without touching git/GitHub — the real executor lands in a
follow-up card.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Iterable, Literal, Protocol, Tuple

if TYPE_CHECKING:
    from app.services.conflict_consolidator import ConsolidatorCardCreator

from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import select

from app.core.event_bus import EventBus
from app.exceptions import BadRequestError, ConflictError, ForbiddenError, ResourceNotFoundError
from app.models.agents.merge_queue import MergeQueueEntry
from app.repositories.merge_queue import MergeQueueRepository
from app.utils import utcnow

logger = logging.getLogger(__name__)


MERGE_QUEUE_ENQUEUED = "merge_queue.enqueued"
MERGE_QUEUE_MERGING = "merge_queue.merging"
MERGE_QUEUE_MERGED = "merge_queue.merged"
MERGE_QUEUE_CONFLICT = "merge_queue.conflict"
MERGE_QUEUE_FAILED = "merge_queue.failed"
MERGE_QUEUE_CI_NOT_GREEN = "merge_queue.ci_not_green"
# Emitted once per entry, by BoardHealthService, when an entry first ages past
# MERGE_QUEUE_STALE_THRESHOLD_SECONDS. Lives here so the whole merge_queue.*
# family has one home, even though this member's publisher is board health.
MERGE_QUEUE_STALE = "merge_queue.stale"

# ci_not_green retry bound: at the default 10s tick this is ~20 minutes of
# CI time before the entry fails terminally — generous for real suites,
# finite for a wedged one. attempt_count is incremented by both mark_merging
# and re_enqueue, so one churn cycle counts twice; the bound accounts for it.
CI_GIVE_UP_ATTEMPTS = 120


MergeResult = (
    Tuple[Literal["merged"], datetime]
    | Tuple[Literal["conflict"], str]
    | Tuple[Literal["failed"], str]
    | Tuple[Literal["ci_not_green"], str]
)


class MergeExecutor(Protocol):
    async def __call__(self, entry: MergeQueueEntry) -> MergeResult: ...


class MergeQueueService:
    def __init__(
        self,
        db: AsyncSession,
        *,
        event_bus: EventBus | None = None,
        consolidator: "ConsolidatorCardCreator | None" = None,
    ):
        self.db = db
        self.repo = MergeQueueRepository(db)
        self._bus = event_bus
        # PAR-3c: optional. When None the queue still records conflicts
        # via mark_conflict but skips the consolidator-card step (preserves
        # PAR-2 behaviour for callers that haven't migrated).
        self._consolidator = consolidator

    async def enqueue(
        self,
        *,
        card_id: uuid.UUID,
        repo_id: uuid.UUID,
        integration_branch: str | None,
        pr_url: str,
        pr_branch: str,
        workspace_id: uuid.UUID,
        actor_id: uuid.UUID | None = None,
    ) -> tuple[MergeQueueEntry, bool]:
        """Idempotent enqueue.

        Returns (entry, created). Re-enqueue of the same card_id returns the
        existing row with created=False — never 409 (idempotent_mutations
        feedback rule). The unique constraint on card_id is the second line
        of defense if a race slips past the SELECT.
        """
        from app.services.completion_policy import CompletionPolicyService
        from app.services.kanban.freeze_guard import assert_board_not_frozen

        completion = CompletionPolicyService(self.db)
        if actor_id is not None:
            await completion.authorize(workspace_id, actor_id, member=True)
        scope = await self.repo.enqueue_scope(card_id, repo_id, workspace_id)
        if scope is None:
            raise ResourceNotFoundError("Card or repository not found in this workspace")
        card, board, git_repo = scope
        board = await completion.lock_board_for_completion(board.id, workspace_id)
        await assert_board_not_frozen(self.db, board.id)
        integration_branch = integration_branch or git_repo.integration_branch or git_repo.default_branch
        if not integration_branch:
            raise BadRequestError("integration_branch is required and could not be inferred", error_code="missing_integration_branch")
        policy = await completion.effective_policy(board)
        if policy is not None:
            if "merge_queue" not in policy.landing_methods or policy.landing_actor == "human":
                raise ForbiddenError("Effective policy requires human external landing", error_code="completion_landing_forbidden")
            if await completion.incompatibilities(board, policy):
                raise ConflictError("Completion policy is incompatible with this board", error_code="completion_policy_incompatible")
            if card.completion_mode != "source" or card.git_repo_slug not in (None, git_repo.slug):
                raise ConflictError("Source card and landing repository must agree", error_code="completion_candidate_mismatch")
            from app.services.completion import CompletionService
            candidate = await CompletionService(self.db).authorize_landing(
                board, card, git_repo, pr_url, pr_branch, integration_branch,
            )
        else:
            await self._enforce_loop_landing_opt_in(repo_id)

        existing = await self.repo.get_by_card_id(card_id)
        if existing is not None:
            if existing.workspace_id != workspace_id or existing.repo_id != repo_id:
                raise ResourceNotFoundError("Merge queue entry not found in this workspace")
            if policy is not None and candidate.merge_sha is None:
                # A freshly reviewed revision may replace a failed/old queue attempt.
                changed = (existing.pr_url, existing.pr_branch, existing.integration_branch) != (pr_url, pr_branch, integration_branch)
                if changed or existing.state not in ("queued", "merging"):
                    existing.pr_url, existing.pr_branch, existing.integration_branch = pr_url, pr_branch, integration_branch
                    await self.repo.re_enqueue(existing.id)
                    await self._publish(MERGE_QUEUE_ENQUEUED, existing, extra={"created": False})
            return existing, False

        entry = await self.repo.enqueue(
            repo_id=repo_id,
            integration_branch=integration_branch,
            card_id=card_id,
            pr_url=pr_url,
            pr_branch=pr_branch,
            workspace_id=workspace_id,
        )
        await self._publish(
            MERGE_QUEUE_ENQUEUED,
            entry,
            extra={"created": True},
        )
        return entry, True

    async def tick(
        self, *, executor: MergeExecutor, max_per_tick: int | None = None
    ) -> int:
        """Process one queued entry per (repo_id, integration_branch).

        Returns the number of entries processed. The worker calls this on a
        timer; in tests it's called directly so there's no timing dependency.
        """
        keys = await self.repo.distinct_active_keys(states=("queued",))
        from app.services.completion_policy import CompletionPolicyService
        scopes = await self.repo.repository_scopes([repo_id for repo_id, _ in keys])
        # Every mutation follows workspace -> board -> queue. Sort workspaces
        # because one tick can retain more than one workspace's locks.
        keys = sorted((key for key in keys if key[0] in scopes), key=lambda key: (*scopes[key[0]], *key))
        processed = 0
        for repo_id, integration_branch in keys:
            if max_per_tick is not None and processed >= max_per_tick:
                break
            workspace_id, board_id = scopes[repo_id]
            await CompletionPolicyService(self.db).lock_board_for_completion(board_id, workspace_id)
            entry = await self.repo.pop_next(
                repo_id=repo_id, integration_branch=integration_branch
            )
            if entry is None:
                continue
            await self.process_entry(entry, executor=executor)
            processed += 1
        return processed

    async def _enforce_loop_landing_opt_in(self, repo_id: uuid.UUID) -> None:
        """Card 51810501, owner decision 2026-08-07: autonomous landing is
        per-board OPT-IN. An AGENT enqueue on a board carrying a loop config
        requires loop_landing="merge_queue". Positive-signal scoping: boards
        WITHOUT a loop config (pure pipeline boards) are untouched — their
        enqueue paths are already operator-gated (workspace merge_via_queue,
        or an explicitly wired lifecycle step) — and humans are never gated.
        A hybrid board (pipeline + loop config) gates its pipeline agents too:
        the operator who configured a loop there owns both knobs, and the
        error names the fix.
        """
        from app.core.auth import current_agent_id

        if current_agent_id.get() is None:
            return
        from app.models.git.git_repo import GitRepo
        from app.models.kanban.board import Board

        loop_config = (
            await self.db.execute(
                select(Board.loop_config)
                .join(GitRepo, GitRepo.board_id == Board.id)
                .where(GitRepo.id == repo_id)
            )
        ).scalar_one_or_none()
        if loop_config is None:
            return
        if loop_config.get("loop_landing") != "merge_queue":
            raise ForbiddenError(
                "Autonomous merge-queue landing is not enabled for this "
                'board — set loop_landing="merge_queue" in the board\'s loop '
                "config to opt in",
                error_code="loop_landing_not_enabled",
            )

    async def process_entry(
        self, entry: MergeQueueEntry, *, executor: MergeExecutor
    ) -> MergeQueueEntry:
        try:
            await self._authorize_entry(entry)
        except Exception as exc:
            failed = await self.repo.mark_failed(entry.id, error_message=f"Completion landing authorization failed: {exc}")
            await self._publish(MERGE_QUEUE_FAILED, failed)
            return failed
        merging = await self.repo.mark_merging(entry.id)
        await self._publish(MERGE_QUEUE_MERGING, merging)

        try:
            result = await executor(entry)
        except Exception as exc:
            logger.exception("merge executor raised for entry %s", entry.id)
            failed = await self.repo.mark_failed(
                entry.id, error_message=f"executor raised: {exc!r}"
            )
            await self._publish(MERGE_QUEUE_FAILED, failed)
            return failed

        outcome = result[0]
        if outcome == "merged":
            merged_at = result[1]
            updated = await self.repo.mark_merged(entry.id, merged_at=merged_at)
            await self._publish(MERGE_QUEUE_MERGED, updated)
            return updated
        if outcome == "conflict":
            updated = await self.repo.mark_conflict(
                entry.id, error_message=result[1]
            )
            await self._publish(MERGE_QUEUE_CONFLICT, updated)
            # PAR-3c: hand off to the consolidator-card creator. If no
            # creator is wired or the workspace hasn't opted in, the entry
            # stays in `conflict`. Otherwise it transitions to
            # `blocked_pending_consolidation` so the operator UI can
            # distinguish "raw failure" from "follow-up card on board".
            if self._consolidator is not None:
                consolidator_card = await self._consolidator.create_for_entry(
                    updated, conflict_message=result[1]
                )
                if consolidator_card is not None:
                    updated = await self.repo.mark_blocked_pending_consolidation(
                        entry.id
                    )
            return updated
        if outcome == "ci_not_green":
            # Retryable WITHOUT human intervention — the whole point vs
            # conflict/failed: CI finishing green is expected to resolve it.
            # Back to `queued` so the next tick re-pops; bounded by
            # CI_GIVE_UP_ATTEMPTS so a wedged CI can't churn forever.
            reason = result[1]
            if (merging.attempt_count or 0) >= CI_GIVE_UP_ATTEMPTS:
                updated = await self.repo.mark_failed(
                    entry.id,
                    error_message=(
                        f"ci_not_green: gave up after {merging.attempt_count} "
                        f"attempts — {reason}"
                    ),
                )
                await self._publish(MERGE_QUEUE_FAILED, updated)
                return updated
            updated = await self.repo.re_enqueue(
                entry.id,
                retry_reason=f"ci_not_green (will retry): {reason}",
            )
            await self._publish(
                MERGE_QUEUE_CI_NOT_GREEN, updated, extra={"reason": reason}
            )
            return updated
        if outcome == "failed":
            updated = await self.repo.mark_failed(
                entry.id, error_message=result[1]
            )
            await self._publish(MERGE_QUEUE_FAILED, updated)
            return updated

        # Defense-in-depth: a misbehaving executor returning an unknown tuple
        # gets recorded as failed rather than silently leaving the entry in
        # 'merging' until human intervention.
        updated = await self.repo.mark_failed(
            entry.id, error_message=f"unknown executor outcome: {outcome!r}"
        )
        await self._publish(MERGE_QUEUE_FAILED, updated)
        return updated

    async def _authorize_entry(self, entry: MergeQueueEntry) -> None:
        from app.services.completion import CompletionService
        from app.services.completion_policy import CompletionPolicyService

        scope = await self.repo.enqueue_scope(entry.card_id, entry.repo_id, entry.workspace_id)
        if scope is None:
            raise ResourceNotFoundError("Merge queue source is no longer available")
        card, board, git_repo = scope
        service = CompletionPolicyService(self.db)
        board = await service.lock_board_for_completion(board.id, entry.workspace_id)
        from app.services.kanban.freeze_guard import assert_board_not_frozen

        await assert_board_not_frozen(self.db, board.id)
        if await service.effective_policy(board) is not None:
            await CompletionService(self.db).authorize_landing(
                board, card, git_repo, entry.pr_url, entry.pr_branch, entry.integration_branch,
            )

    async def list_active(
        self,
        *,
        repo_id: uuid.UUID,
        integration_branch: str,
        states: Iterable[str] = ("queued", "merging"),
    ) -> list[MergeQueueEntry]:
        return await self.repo.list_active(
            repo_id=repo_id,
            integration_branch=integration_branch,
            states=states,
        )

    async def list_workspace_active(
        self,
        *,
        workspace_id: uuid.UUID,
        merged_within_hours: int | None = None,
    ) -> list[MergeQueueEntry]:
        """In-flight entries, optionally widened with recently-merged ones.

        `merged_within_hours` is a lookback, not a toggle: the caller must say
        how far back it wants to see, so the terminal `merged` rows can never
        be requested unbounded.
        """
        merged_since = (
            utcnow() - timedelta(hours=merged_within_hours)
            if merged_within_hours is not None
            else None
        )
        return await self.repo.list_workspace_active(
            workspace_id=workspace_id,
            merged_since=merged_since,
        )

    async def cancel(self, entry_id: uuid.UUID) -> None:
        await self.repo.cancel(entry_id)

    async def re_enqueue_parent(
        self, parent_card_id: uuid.UUID, *, workspace_id: uuid.UUID | None = None, actor_id: uuid.UUID | None = None,
    ) -> MergeQueueEntry:
        """Re-queue the merge-queue entry for a parent card after consolidation.

        Used by the consolidator pipeline once it has resolved the conflict:
        the consolidator stage POSTs back to /re-enqueue with the original
        card_id and the worker tries the merge again. Idempotent — calling
        this twice when the entry is already `queued` is a no-op (returns
        the existing row, no duplicate event).
        """
        entry = await self.repo.get_by_card_id(parent_card_id)
        if entry is None or (workspace_id is not None and entry.workspace_id != workspace_id):
            raise ResourceNotFoundError(
                f"no merge_queue entry for card {parent_card_id}"
            )
        if actor_id is not None:
            from app.services.completion_policy import CompletionPolicyService
            await CompletionPolicyService(self.db).authorize(entry.workspace_id, actor_id, member=True)
        await self._authorize_entry(entry)
        await self.db.refresh(entry)
        was_queued = entry.state == "queued"
        re_enqueued = await self.repo.re_enqueue(entry.id)
        if not was_queued:
            await self._publish(
                MERGE_QUEUE_ENQUEUED,
                re_enqueued,
                extra={"created": False, "re_enqueue": True},
            )
        return re_enqueued

    async def _publish(
        self,
        event_type: str,
        entry: MergeQueueEntry,
        *,
        extra: dict | None = None,
    ) -> None:
        if self._bus is None:
            return
        payload = {
            "entry_id": str(entry.id),
            "card_id": str(entry.card_id),
            "repo_id": str(entry.repo_id),
            "integration_branch": entry.integration_branch,
            "pr_url": entry.pr_url,
            "pr_branch": entry.pr_branch,
            "state": entry.state,
            "attempt_count": entry.attempt_count,
        }
        if entry.error_message is not None:
            payload["error_message"] = entry.error_message
        if entry.merged_at is not None:
            payload["merged_at"] = entry.merged_at.isoformat()
        if extra:
            payload.update(extra)
        try:
            await self._bus.publish(
                event_type=event_type,
                payload=payload,
                workspace_id=entry.workspace_id,
            )
        except Exception:
            logger.exception("failed to publish %s for %s", event_type, entry.id)


async def run_merge_queue_tick(
    session_factory,
    *,
    event_bus: EventBus,
    executor: MergeExecutor,
    max_per_tick: int | None = None,
) -> int:
    """One worker pass, owning its session AND its transaction — the main.py
    loop only adds asyncio scheduling on top (reconciler `scan_once` shape).

    The transaction boundary must live here, not in the loop: a bare
    `async with session_factory()` rolls back at close, so every tick's
    state transitions evaporated — entries pinned at queued/attempt_count=0
    with no error_message while the executor silently retried forever
    (field report 2026-08-07).
    """
    # Local imports: ConsolidatorCardCreator pulls in CardService; keep the
    # module import graph acyclic (main.py precedent).
    from app.services.conflict_consolidator import ConsolidatorCardCreator
    from app.services.kanban.card import CardService

    async with session_factory() as db:
        async with db.begin():
            consolidator = ConsolidatorCardCreator(
                db, card_service=CardService(db), event_bus=event_bus
            )
            service = MergeQueueService(
                db, event_bus=event_bus, consolidator=consolidator
            )
            processed = await service.tick(
                executor=executor, max_per_tick=max_per_tick
            )
    if processed:
        logger.info("merge queue tick: processed %d entries", processed)
    return processed
