# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import hashlib
import hmac
import json
import re
import secrets
from datetime import UTC, timedelta
from urllib.parse import urlparse

from app.core.event_bus import event_bus
from app.exceptions import (
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.agents.execution import ExecutionStatus
from app.repositories.completion_candidates import CompletionCandidateRepository
from app.repositories.git.git_repo import GitRepoRepository
from app.repositories.kanban.column import ColumnRepository
from app.schemas.completion import CompletionPolicyV1
from app.services.completion_policy import CompletionPolicyService, policy_hash
from app.utils import utcnow

_SHA = re.compile(r"^[a-f0-9]{40}([a-f0-9]{24})?$")
_PENDING = {"awaiting_review", "awaiting_validation"}


def digest(value):
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def card_fingerprint(card):
    return digest(
        {
            key: getattr(card, key, None)
            for key in (
                "pr_url",
                "git_repo_slug",
                "completion_mode",
                "branch_name",
                "title",
                "description",
            )
        }
    )


def canonical_repo_url(value):
    parsed = urlparse(value or "")
    return (parsed.hostname or "").lower() + parsed.path.rstrip("/").removesuffix(
        ".git"
    ).lower()


def naive_now():
    return utcnow().replace(tzinfo=None)


class CompletionService:
    def __init__(self, db):
        self.db = db
        self.repo = CompletionCandidateRepository(db)
        self.policy_service = CompletionPolicyService(db)

    async def _scope(
        self,
        board_id,
        workspace_id,
        actor_id,
        card_id=None,
        *,
        mutate=False,
        runner=False,
    ):
        board = await self.policy_service.get_board(
            board_id, workspace_id, actor_id, lock=mutate, member=mutate
        )
        if runner:
            self._runner()
        card = None
        if card_id is not None:
            card = await self.policy_service.repo.card(card_id, board_id, lock=mutate)
            if card is None:
                raise ResourceNotFoundError(
                    "Card not found", error_code="card_not_found"
                )
        if mutate:
            from app.services.kanban.freeze_guard import assert_board_not_frozen

            await assert_board_not_frozen(self.db, board_id)
        return board, card

    def _runner(self):
        from app.core.auth import current_agent_id

        agent_id = current_agent_id.get()
        if agent_id is None:
            raise ForbiddenError(
                "This completion operation requires an authorized runner",
                error_code="completion_runner_required",
            )
        return agent_id

    async def _policy(self, board):
        policy = await self.policy_service.effective_policy(board)
        if policy is None:
            raise ConflictError(
                "Select an explicit completion policy before submitting work",
                error_code="completion_policy_required",
            )
        issues = await self.policy_service.incompatibilities(board, policy)
        if issues:
            raise ConflictError(
                "Completion policy is incompatible with the current board",
                error_code="completion_policy_incompatible",
                context={"incompatibilities": issues},
            )
        return policy

    async def _repo_for_card(self, board, card):
        repo_service = GitRepoRepository(self.db)
        if card.git_repo_slug:
            repo = await repo_service.get_by_slug(board.id, card.git_repo_slug)
        else:
            repos = await repo_service.list_by_board(board.id)
            repo = repos[-1] if repos else None
        if repo is None or repo.workspace_id != board.workspace_id:
            raise ConflictError(
                "Completion requires the card's exact configured repository",
                error_code="completion_repo_required",
            )
        return repo

    async def _forge_status(self, board, card, repo):
        if not card.pr_url:
            raise ConflictError(
                "Source completion requires its own pull request",
                error_code="completion_pr_required",
            )
        provider = repo.provider.value if repo.provider else "unknown"
        pr = urlparse(card.pr_url)
        repo_identity = canonical_repo_url(repo.url)
        if (
            provider != "github"
            or not re.fullmatch(r"/[^/]+/[^/]+/pull/[1-9][0-9]*", pr.path)
            or (pr.hostname or "").lower() + pr.path.rsplit("/pull/", 1)[0].lower()
            != repo_identity
        ):
            raise ConflictError(
                "The pull request must belong to the configured supported repository",
                error_code="completion_repo_mismatch",
            )
        from app.services.kanban import reconciler

        status = await reconciler.board_scoped_pr_status(self.db, board.id, card.pr_url)
        if status is None:
            raise ConflictError(
                "The forge could not verify this candidate; restore repository access and retry",
                error_code="completion_forge_unavailable",
            )
        self._validate_status(repo, card, status)
        return status

    def _validate_status(self, repo, card, status):
        target = repo.integration_branch or repo.default_branch
        if (
            not _SHA.fullmatch(getattr(status, "head_sha", "") or "")
            or getattr(status, "head_branch", None) != card.branch_name
            or not card.branch_name
            or getattr(status, "base_branch", None) != target
            or canonical_repo_url(getattr(status, "base_repo_url", None))
            != canonical_repo_url(repo.url)
        ):
            raise ConflictError(
                "Authoritative pull request head, branch or repository does not match the source card",
                error_code="completion_candidate_mismatch",
            )

    async def current_candidate(self, board, card, refresh=True):
        candidate = await self.repo.current(board.id, card.id)
        if candidate is None:
            return None
        policy = await self.policy_service.effective_policy(board)
        repo = await GitRepoRepository(self.db).get_by_id(candidate.repo_id)
        current = (
            policy is not None
            and candidate.policy_hash == policy_hash(policy.model_dump())
            and candidate.card_hash == card_fingerprint(card)
            and repo is not None
            and repo.board_id == board.id
            and repo.workspace_id == board.workspace_id
            and candidate.repo_url == repo.url
            and (
                candidate.completion_mode == "evidence_only"
                or candidate.target_branch
                == (repo.integration_branch or repo.default_branch)
            )
        )
        if not current:
            if refresh:
                await self._invalidate(
                    candidate, "Completion configuration or source metadata changed"
                )
            return None
        return candidate

    async def is_accepted(self, board, card):
        candidate = await self.current_candidate(board, card, refresh=False)
        return bool(candidate is not None and candidate.status == "accepted")

    async def invalidate_card(self, board, card, reason="Source card changed"):
        candidate = await self.repo.current(board.id, card.id, lock=True)
        if candidate is not None:
            await self._invalidate(candidate, reason)

    async def invalidate_board(self, board, reason="Completion policy changed"):
        for candidate in await self.repo.board_candidates(board.id):
            await self._invalidate(candidate, reason)

    async def _invalidate(self, candidate, reason):
        await self.repo.update(
            candidate, is_current=False, status="stale", summary=reason
        )
        attempt = await self.repo.active_attempt(candidate.id)
        if attempt:
            await self.repo.update(attempt, status="stale", completed_at=naive_now())
            execution = await self.repo.execution(attempt.execution_id)
            await self.repo.update(
                execution,
                status=ExecutionStatus.aborted,
                completed_at=naive_now(),
                error_message=reason,
            )
        await self._publish(candidate)

    def _public_candidate(self, candidate):
        if candidate is None:
            return None
        fields = (
            "id",
            "completion_mode",
            "status",
            "source_sha",
            "merge_sha",
            "pr_url",
            "repo_id",
            "repo_url",
            "branch",
            "target_branch",
            "source_execution_id",
            "source_agent_id",
            "submitted_by",
            "policy_hash",
            "contract_hash",
            "review_passed",
            "failed_kind",
            "summary",
            "artifacts",
            "checks",
            "accepted_at",
            "created_at",
            "updated_at",
        )
        return {key: getattr(candidate, key) for key in fields}

    def _public_attempt(self, attempt):
        return {
            key: getattr(attempt, key)
            for key in (
                "id",
                "candidate_id",
                "execution_id",
                "agent_id",
                "kind",
                "role",
                "provider",
                "model",
                "source_sha",
                "status",
                "expires_at",
                "completed_at",
                "result",
                "created_at",
            )
        }

    async def _status(self, board, card):
        current = await self.current_candidate(board, card)
        history = await self.repo.history(board.id, card.id)
        attempts = await self.repo.attempts([candidate.id for candidate in history])
        return {
            "completion_mode": card.completion_mode,
            "candidate": self._public_candidate(
                current or (history[0] if history else None)
            ),
            "attempts": [self._public_attempt(attempt) for attempt in attempts],
            "history": [self._public_candidate(candidate) for candidate in history],
        }

    async def status(self, board_id, workspace_id, actor_id, card_id):
        board, card = await self._scope(board_id, workspace_id, actor_id, card_id)
        return await self._status(board, card)

    async def submit(self, board_id, workspace_id, actor_id, card_id, data):
        board, card = await self._scope(
            board_id, workspace_id, actor_id, card_id, mutate=True, runner=True
        )
        policy = await self._policy(board)
        agent_id = self._runner()
        execution = await self.repo.source_execution(
            data.source_execution_id, workspace_id, board_id, agent_id
        )
        if execution is None:
            raise ResourceNotFoundError("Source execution not found for this card")
        if str(card.id) not in (execution.cards_affected or []):
            if execution.action != "loop_iteration" or execution.status not in (
                ExecutionStatus.started,
                ExecutionStatus.running,
            ):
                raise ResourceNotFoundError("Source execution not found for this card")
            # A live loop picks cards during execution. Bind its first submission
            # here, after runner/workspace/board ownership was verified above.
            await self.repo.update(
                execution,
                cards_affected=[*(execution.cards_affected or []), str(card.id)],
            )
        if execution.status not in (
            ExecutionStatus.started,
            ExecutionStatus.running,
            ExecutionStatus.completed,
        ) or execution.action.startswith("completion_"):
            raise ConflictError(
                "A completion check cannot act as the source execution",
                error_code="completion_source_execution_invalid",
            )
        repo = await self._repo_for_card(board, card)
        policy_data = policy.model_dump()
        artifacts = [artifact.model_dump() for artifact in data.artifacts]
        checks = [check.model_dump() for check in data.checks]
        if card.completion_mode == "evidence_only":
            if (
                not policy.evidence_only.enabled
                or not data.source_sha
                or not artifacts
                or not checks
            ):
                raise ValidationError(
                    "Evidence-only completion requires an enabled policy, exact source SHA, artifacts and named checks",
                    error_code="completion_evidence_required",
                )
            if card.pr_url or card.branch_name:
                raise ValidationError(
                    "Evidence-only work must not inherit a source pull request or branch",
                    error_code="completion_evidence_source_conflict",
                )
            if (
                any(
                    check.source_sha != data.source_sha or check.exit_code != 0
                    for check in data.checks
                )
                or len({check.id for check in data.checks}) != len(checks)
                or len({artifact.name for artifact in data.artifacts}) != len(artifacts)
            ):
                raise ValidationError(
                    "Evidence checks must be distinct successful results on the exact source SHA",
                    error_code="completion_evidence_invalid",
                )
            source_sha = data.source_sha
            pr_url = branch = target = None
            require_review = policy.evidence_only.approval == "independent"
        else:
            status = await self._forge_status(board, card, repo)
            source_sha = status.head_sha
            if data.source_sha and data.source_sha != source_sha:
                raise ConflictError(
                    "Submitted source SHA is not the current pull request head",
                    error_code="completion_candidate_mismatch",
                )
            pr_url, branch, target = (
                card.pr_url,
                card.branch_name,
                repo.integration_branch or repo.default_branch,
            )
            require_review = policy.source_review == "independent"
        identity = {
            "card_hash": card_fingerprint(card),
            "source_sha": source_sha,
            "source_execution_id": str(execution.id),
            "repo_id": str(repo.id),
            "repo_url": repo.url,
            "policy": policy_data,
            "artifacts": artifacts,
            "checks": checks,
        }
        fingerprint = digest(identity)
        existing = await self.current_candidate(board, card)
        if existing is not None and existing.fingerprint == fingerprint:
            return await self._status(board, card)
        if card.completion_mode == "source" and (
            status.merged or status.state != "open"
        ):
            raise ConflictError(
                "Submit the source candidate while its own pull request is open, before merge",
                error_code="completion_source_already_merged",
            )
        if existing is not None:
            await self._invalidate(
                existing, "A new source or evidence revision was submitted"
            )
        candidate = await self.repo.create_candidate(
            workspace_id=workspace_id,
            board_id=board_id,
            card_id=card_id,
            completion_mode=card.completion_mode,
            status="awaiting_review" if require_review else "awaiting_merge",
            source_execution_id=execution.id,
            source_agent_id=agent_id,
            submitted_by=actor_id,
            repo_id=repo.id,
            repo_url=repo.url,
            source_sha=source_sha,
            pr_url=pr_url,
            branch=branch,
            target_branch=target,
            policy_hash=policy_hash(policy_data),
            contract_hash=digest(
                {
                    "postmerge_validation": policy_data["postmerge_validation"],
                    "evidence_only": policy_data["evidence_only"],
                    "source_review": policy_data["source_review"],
                    "review_role": policy_data["review_role"],
                }
            ),
            card_hash=card_fingerprint(card),
            fingerprint=fingerprint,
            policy=policy_data,
            artifacts=artifacts,
            checks=checks,
            review_passed=not require_review,
        )
        if card.completion_mode == "evidence_only" and not require_review:
            await self._accept(board, card, candidate)
        await self._publish(candidate)
        return await self._status(board, card)

    async def authorize_landing(self, board, card, repo, pr_url, branch, target):
        policy = await self._policy(board)
        candidate = await self.current_candidate(board, card)
        if (
            policy.landing_actor == "human"
            or "merge_queue" not in policy.landing_methods
        ):
            raise ForbiddenError(
                "This policy requires human external landing",
                error_code="completion_landing_forbidden",
            )
        if (
            candidate is None
            or candidate.completion_mode != "source"
            or not candidate.review_passed
            or candidate.status
            not in ("awaiting_merge", "awaiting_validation", "accepted")
        ):
            raise ConflictError(
                "A current approved source candidate is required before landing",
                error_code="completion_candidate_required",
            )
        if (
            candidate.repo_id != repo.id
            or candidate.repo_url != repo.url
            or candidate.pr_url != pr_url
            or candidate.branch != branch
            or candidate.target_branch != target
        ):
            raise ConflictError(
                "Landing request does not match the accepted source candidate",
                error_code="completion_candidate_mismatch",
            )
        status = await self._forge_status(board, card, repo)
        if status.head_sha != candidate.source_sha:
            raise ConflictError(
                "Pull request head changed; submit and review the new source revision",
                error_code="completion_candidate_stale",
            )
        return candidate

    async def land(self, board_id, workspace_id, actor_id, card_id, data):
        board, card = await self._scope(
            board_id, workspace_id, actor_id, card_id, mutate=True
        )
        repo = await self._repo_for_card(board, card)
        await self.authorize_landing(
            board,
            card,
            repo,
            card.pr_url,
            card.branch_name,
            repo.integration_branch or repo.default_branch,
        )
        await self._enqueue(board, card, repo)
        return await self._status(board, card)

    async def _enqueue(self, board, card, repo):
        from app.services.merge_queue import MergeQueueService

        return await MergeQueueService(self.db, event_bus=event_bus).enqueue(
            card_id=card.id,
            repo_id=repo.id,
            workspace_id=board.workspace_id,
            pr_url=card.pr_url,
            pr_branch=card.branch_name,
            integration_branch=repo.integration_branch or repo.default_branch,
        )

    async def record_merge(self, board, card, status):
        candidate = await self.current_candidate(board, card)
        if candidate is None:
            return None
        repo = await self._repo_for_card(board, card)
        self._validate_status(repo, card, status)
        if (
            candidate.completion_mode != "source"
            or not status.merged
            or candidate.source_sha != status.head_sha
            or candidate.repo_id != repo.id
            or candidate.pr_url != card.pr_url
            or not candidate.review_passed
        ):
            raise ConflictError(
                "Merged source does not match the current approved completion candidate",
                error_code="completion_candidate_mismatch",
            )
        merge_sha = getattr(status, "merge_commit_sha", None)
        if not _SHA.fullmatch(merge_sha or "") or (
            candidate.merge_sha is not None and candidate.merge_sha != merge_sha
        ):
            raise ConflictError(
                "The exact merged commit is missing or changed",
                error_code="completion_merge_sha_invalid",
            )
        if candidate.status == "accepted":
            return candidate
        if candidate.status == "failed":
            return candidate  # Failure requires an explicit retry, never a polling retry loop.
        policy = CompletionPolicyV1.model_validate(candidate.policy)
        if (
            policy.require_forge_checks
            and getattr(status, "checks_passed", None) is not True
        ):
            raise ConflictError(
                "Required forge checks have not passed for the accepted source revision",
                error_code="completion_forge_checks_required",
            )
        await self.repo.update(
            candidate,
            merge_sha=merge_sha,
            status="awaiting_validation"
            if policy.postmerge_validation
            else "awaiting_merge",
        )
        if policy.postmerge_validation is None:
            await self._accept(board, card, candidate)
        await self._publish(candidate)
        return candidate

    async def _accept(self, board, card, candidate):
        await self.repo.update(
            candidate, status="accepted", accepted_at=naive_now(), failed_kind=None
        )
        policy = CompletionPolicyV1.model_validate(candidate.policy)
        if policy.auto_complete:
            from app.models.kanban.column import ColumnType
            from app.schemas.kanban.card import CardMoveRequest
            from app.services.kanban.card import CardService

            columns = await ColumnRepository(self.db).list_by_board(board.id)
            done = next(
                (column for column in columns if column.column_type == ColumnType.done),
                None,
            )
            if done:
                await CardService(self.db).move_card(
                    card.id,
                    board.id,
                    CardMoveRequest(column_id=done.id),
                    workspace_id=board.workspace_id,
                    actor_id=candidate.submitted_by,
                )
        await self._publish(candidate)

    async def retry(self, board_id, workspace_id, actor_id, card_id):
        board, card = await self._scope(
            board_id, workspace_id, actor_id, card_id, mutate=True
        )
        candidate = await self.current_candidate(board, card)
        if candidate is None:
            raise ConflictError(
                "Submit a current candidate before retrying",
                error_code="completion_candidate_required",
            )
        attempt = await self.repo.active_attempt(candidate.id)
        if attempt and attempt.context_hash:
            execution = await self.repo.execution(attempt.execution_id)
            code, changed = await self._attempt_context_change(
                board, card, candidate, attempt, execution
            )
            if code:
                receipt = self._rejection_receipt(attempt, code, True, changed)
                await self.repo.update(
                    attempt,
                    status="rejected",
                    completed_at=naive_now(),
                    result={"receipt": receipt},
                )
                await self.repo.update(
                    execution,
                    status=ExecutionStatus.aborted,
                    completed_at=naive_now(),
                    error_message=code,
                )
                await self.repo.update(
                    candidate, status="failed", failed_kind=attempt.kind
                )
        if candidate.status == "failed":
            await self.repo.update(
                candidate,
                status="awaiting_validation"
                if candidate.failed_kind == "validation"
                else "awaiting_review",
                failed_kind=None,
                summary=None,
            )
            await self._publish(candidate)
        return await self._status(board, card)

    async def rework(self, board_id, workspace_id, actor_id, card_id, data):
        from app.services.completion_rework import dispatch_rework

        return await dispatch_rework(
            self, board_id, workspace_id, actor_id, card_id, data
        )

    async def work(self, board_id, workspace_id, actor_id, *, cursor=None, limit=100):
        from app.services.completion_work_status import read_work_status

        board, _ = await self._scope(board_id, workspace_id, actor_id)
        return await read_work_status(self, board, cursor=cursor, limit=limit)

    async def work_counts(self, board, *, invalid_candidate_ids=None):
        counts = {
            "pending_count": 0, "actionable_count": 0, "failed_count": 0, "rework_count": 0
        }
        for candidate in await self.repo.board_candidates(board.id):
            card = await self.policy_service.repo.card(candidate.card_id, board.id)
            if (
                card is None
                or await self.current_candidate(board, card, refresh=False) is None
            ):
                if invalid_candidate_ids is not None:
                    invalid_candidate_ids.add(candidate.id)
                continue
            if candidate.status == "failed":
                counts["failed_count"] += 1
                from app.services.completion_rework import review_rework

                failure, prior = await review_rework(self, candidate)
                if failure is not None and prior is None:
                    counts["rework_count"] += 1
            elif candidate.status in _PENDING:
                counts["pending_count"] += 1
                if await self.repo.active_rework(candidate, naive_now()):
                    continue
                attempt = await self.repo.active_attempt(candidate.id, lock=False)
                if (
                    attempt is None
                    or attempt.expires_at.replace(tzinfo=None) <= naive_now()
                ):
                    counts["actionable_count"] += 1
            elif candidate.status == "awaiting_merge":
                counts["pending_count"] += 1
        return counts

    async def _role(self, board, candidate):
        policy = CompletionPolicyV1.model_validate(candidate.policy)
        if candidate.status == "awaiting_validation":
            kind, role = "validation", policy.postmerge_validation.role
            checks = [
                check.model_dump() for check in policy.postmerge_validation.checks
            ]
        elif candidate.completion_mode == "evidence_only":
            kind, role, checks = "evidence_review", policy.evidence_only.review_role, []
        else:
            kind, role, checks = "review", policy.review_role, []
        dispatch = await self._resolve_role(board, kind, role)
        return kind, role, dispatch, checks

    async def _resolve_role(self, board, kind, role):
        config = await self.policy_service.repo.workspace_config(board.workspace_id)
        from app.services.workspace_config import DEFAULT_PIPELINE_CONFIG
        from app.services.completion_roles import resolve_completion_role

        pipeline = (
            config.pipeline_config
            if config and config.pipeline_config is not None
            else DEFAULT_PIPELINE_CONFIG
        )
        return await resolve_completion_role(
            self.db,
            board.workspace_id,
            role,
            pipeline,
            direct_checks=kind == "validation",
        )

    async def readiness(self, board_id, workspace_id, actor_id):
        from app.services.completion_readiness import completion_readiness

        board, _ = await self._scope(board_id, workspace_id, actor_id)
        policy = await self.policy_service.effective_policy(board)
        return await completion_readiness(self, board, policy)

    async def requirements(self, board_id, workspace_id, actor_id):
        board, _ = await self._scope(board_id, workspace_id, actor_id)
        policy = await self.policy_service.effective_policy(board)
        policies = [policy] if policy is not None else []
        # Preflight must not expire leases or invalidate candidates as status reads do.
        for candidate in await self.repo.board_candidates(board.id):
            if candidate.status not in _PENDING | {"awaiting_merge"}:
                continue
            card = await self.policy_service.repo.card(candidate.card_id, board.id)
            if card is None:
                continue
            if await self.current_candidate(board, card, refresh=False) is not None:
                policies.append(CompletionPolicyV1.model_validate(candidate.policy))
        requirements = []
        seen = set()
        for selected in policies:
            roles = []
            if selected.source_review == "independent":
                roles.append(("review", selected.review_role, []))
            if selected.postmerge_validation:
                roles.append(
                    (
                        "validation",
                        selected.postmerge_validation.role,
                        [
                            check.model_dump()
                            for check in selected.postmerge_validation.checks
                        ],
                    )
                )
            if (
                selected.evidence_only.enabled
                and selected.evidence_only.approval == "independent"
            ):
                roles.append(
                    ("evidence_review", selected.evidence_only.review_role, [])
                )
            for kind, role, checks in roles:
                dispatch = await self._resolve_role(board, kind, role)
                requirement = {
                    "kind": kind,
                    "role": role,
                    "provider": dispatch.provider,
                    "model": dispatch.model,
                    "checks": checks,
                    "tool_policy": dispatch.tool_policy,
                }
                key = digest(requirement)
                if key not in seen:
                    seen.add(key)
                    requirements.append(requirement)
        return {
            "policy_hash": policy_hash(policy.model_dump()) if policy else None,
            "requirements": requirements,
        }

    async def claim(self, board_id, workspace_id, actor_id, data):
        board, _ = await self._scope(
            board_id, workspace_id, actor_id, mutate=True, runner=True
        )
        await self._policy(board)
        agent_id = self._runner()
        for candidate in await self.repo.board_candidates(board.id):
            if candidate.status not in _PENDING:
                continue
            card = await self.policy_service.repo.card(
                candidate.card_id, board_id, lock=True
            )
            candidate = await self.current_candidate(board, card)
            if candidate is None:
                continue
            if await self.repo.active_rework(candidate, naive_now()):
                continue
            prior = await self.repo.active_attempt(candidate.id)
            if prior and prior.expires_at.replace(tzinfo=None) > naive_now():
                continue
            if prior:
                await self.repo.update(
                    prior, status="expired", completed_at=naive_now()
                )
                execution = await self.repo.execution(prior.execution_id)
                await self.repo.update(
                    execution,
                    status=ExecutionStatus.aborted,
                    completed_at=naive_now(),
                    error_message="Completion lease expired",
                )
            kind, role, dispatch, checks = await self._role(board, candidate)
            provider, model = dispatch.provider, dispatch.model
            missing = []
            if provider and provider not in data.capabilities.providers:
                missing.append(f"provider '{provider}' for role '{role}'")
            if not data.capabilities.exact_checkout:
                missing.append("exact revision checkout")
            if kind == "validation" and not data.capabilities.argv_checks:
                missing.append("direct argv check execution")
            if missing:
                raise ConflictError(
                    "Runner is missing "
                    + ", ".join(missing)
                    + "; configure these capabilities before claiming completion work",
                    error_code="completion_runner_incompatible",
                )
            source_sha = (
                candidate.merge_sha if kind == "validation" else candidate.source_sha
            )
            execution = await self.repo.create_execution(
                agent_id=agent_id,
                workspace_id=workspace_id,
                board_id=board_id,
                action="completion_" + kind,
                role=role,
                provider=provider,
                model=model,
                status=ExecutionStatus.started,
                cards_affected=[str(card.id)],
                input_summary=f"{kind} for exact completion candidate {candidate.id}",
                prompt_slug=dispatch.prompt_slug or None,
            )
            from app.services.completion_context import (
                completion_execution_context,
                completion_context_manifest,
            )

            context, binding = await completion_execution_context(
                self.db,
                board,
                card,
                candidate,
                execution,
                dispatch,
                kind=kind,
                role=role,
                source_sha=source_sha,
                checks=checks,
                public_candidate=self._public_candidate(candidate),
            )
            await self.repo.update(execution, input_prompt=context)
            lease = secrets.token_urlsafe(32)
            timeout = (
                min(
                    50 * 3600 + 600,
                    sum(check["timeout_seconds"] for check in checks) + 600,
                )
                if kind == "validation"
                else 3600
            )
            expires = naive_now() + timedelta(seconds=timeout)
            attempt = await self.repo.create_attempt(
                candidate_id=candidate.id,
                workspace_id=workspace_id,
                board_id=board_id,
                execution_id=execution.id,
                agent_id=agent_id,
                kind=kind,
                role=role,
                provider=provider,
                model=model,
                source_sha=source_sha,
                context_hash=digest(binding),
                context_manifest=await completion_context_manifest(
                    self.db, board, dispatch, binding, card=card
                ),
                lease_hash=hashlib.sha256(lease.encode()).hexdigest(),
                expires_at=expires,
            )
            await self._publish(candidate)
            return {
                "work": {
                    "attempt_id": attempt.id,
                    "lease_token": lease,
                    "candidate_id": candidate.id,
                    "card_id": card.id,
                    "execution_id": execution.id,
                    "kind": kind,
                    "role": role,
                    "provider": provider,
                    "model": model,
                    "repo_url": candidate.repo_url,
                    "source_sha": source_sha,
                    "policy_hash": candidate.policy_hash,
                    "contract_hash": candidate.contract_hash,
                    "context": context,
                    "tool_policy": dispatch.tool_policy,
                    "checks": checks,
                    "artifacts": candidate.artifacts,
                    "expires_at": expires.replace(tzinfo=UTC),
                }
            }
        return {"work": None}

    async def result(self, board_id, workspace_id, actor_id, attempt_id, data):
        board, _ = await self._scope(
            board_id, workspace_id, actor_id, mutate=True, runner=True
        )
        attempt = await self.repo.attempt(board_id, attempt_id)
        if (
            attempt is None
            or attempt.workspace_id != workspace_id
            or attempt.agent_id != self._runner()
        ):
            raise ResourceNotFoundError("Completion attempt not found")
        if not hmac.compare_digest(
            attempt.lease_hash, hashlib.sha256(data.lease_token.encode()).hexdigest()
        ):
            raise ForbiddenError(
                "Invalid completion lease", error_code="completion_lease_invalid"
            )
        # Resolve card through authorized candidate history without trusting request candidate_id.
        candidate = await self.repo.candidate(board_id, attempt.candidate_id)
        card = await self.policy_service.repo.card(
            candidate.card_id, board_id, lock=True
        )
        attempt = await self.repo.attempt(board_id, attempt_id, lock=True)
        if (
            data.candidate_id != candidate.id
            or data.policy_hash != candidate.policy_hash
            or data.contract_hash != candidate.contract_hash
            or data.source_sha != attempt.source_sha
        ):
            raise ConflictError(
                "Completion result targets a different claimed identity",
                error_code="completion_result_stale",
            )
        result_data = data.model_dump(mode="json", exclude={"lease_token"})
        if data.failure_class is None:
            result_data.pop("failure_class", None)
        result_hash = digest(result_data)
        if attempt.result_hash:
            if attempt.result_hash != result_hash:
                raise ConflictError(
                    "A different result was already recorded for this attempt",
                    error_code="completion_result_conflict",
                )
            return await self._result_status(board, card, attempt)
        execution = await self.repo.execution(attempt.execution_id)
        if (
            execution is None
            or execution.id == candidate.source_execution_id
            or execution.agent_id != self._runner()
            or execution.board_id != board_id
            or execution.workspace_id != workspace_id
        ):
            raise ForbiddenError(
                "Completion result requires its independent server-created execution"
            )
        current = await self.current_candidate(board, card)
        if current is None or current.id != candidate.id:
            return await self._reject_result(
                board,
                card,
                candidate,
                attempt,
                execution,
                result_data,
                "completion_candidate_stale",
                retryable=False,
            )
        if (
            attempt.status != "claimed"
            or attempt.expires_at.replace(tzinfo=None) <= naive_now()
        ):
            return await self._reject_result(
                board,
                card,
                candidate,
                attempt,
                execution,
                result_data,
                "completion_lease_expired",
                retryable=attempt.status == "claimed",
            )
        code, changed = await self._attempt_context_change(
            board, card, candidate, attempt, execution
        )
        if code:
            return await self._reject_result(
                board,
                card,
                candidate,
                attempt,
                execution,
                result_data,
                code,
                retryable=True,
                changed_sources=changed,
            )
        if data.outcome == "passed":
            if any(
                check.source_sha != attempt.source_sha or check.exit_code != 0
                for check in data.checks
            ):
                raise ConflictError(
                    "Passed checks must succeed on the exact claimed revision",
                    error_code="completion_check_mismatch",
                )
            if attempt.kind == "validation":
                expected = {
                    check["id"]
                    for check in candidate.policy["postmerge_validation"]["checks"]
                }
                if {check.id for check in data.checks} != expected or len(
                    data.checks
                ) != len(expected):
                    raise ConflictError(
                        "Every configured validation check requires exactly one result",
                        error_code="completion_check_mismatch",
                    )
            if candidate.completion_mode == "source":
                repo = await self._repo_for_card(board, card)
                status = await self._forge_status(board, card, repo)
                if attempt.kind == "review" and (
                    status.merged or status.state != "open"
                ):
                    await self._invalidate(
                        candidate,
                        "Source review cannot accept a pull request that closed before its review completed",
                    )
                    return await self._reject_result(
                        board,
                        card,
                        candidate,
                        attempt,
                        execution,
                        result_data,
                        "completion_review_after_merge",
                        retryable=False,
                    )
                if status.head_sha != candidate.source_sha or (
                    attempt.kind == "validation"
                    and (
                        not status.merged
                        or getattr(status, "merge_commit_sha", None)
                        != candidate.merge_sha
                    )
                ):
                    await self._invalidate(
                        candidate, "Source candidate changed during completion work"
                    )
                    return await self._reject_result(
                        board,
                        card,
                        candidate,
                        attempt,
                        execution,
                        result_data,
                        "completion_candidate_stale",
                        retryable=False,
                    )
                if (
                    attempt.kind == "validation"
                    and candidate.policy["require_forge_checks"]
                    and getattr(status, "checks_passed", None) is not True
                ):
                    return await self._reject_result(
                        board,
                        card,
                        candidate,
                        attempt,
                        execution,
                        result_data,
                        "completion_forge_checks_required",
                        retryable=True,
                    )
        await self.repo.update(
            attempt,
            status=data.outcome,
            result_hash=result_hash,
            result=result_data,
            completed_at=naive_now(),
        )
        await self.repo.update(
            execution,
            status=ExecutionStatus.completed
            if data.outcome == "passed"
            else ExecutionStatus.failed,
            completed_at=naive_now(),
            output_summary=data.summary,
            tokens_used=data.tokens_used,
            cost_usd=data.cost_usd,
            duration_seconds=data.duration_seconds,
        )
        await self.repo.update(candidate, summary=data.summary)
        if data.outcome == "failed":
            await self.repo.update(candidate, status="failed", failed_kind=attempt.kind)
        elif attempt.kind in ("validation", "evidence_review"):
            await self.repo.update(candidate, review_passed=True)
            await self._accept(board, card, candidate)
        else:
            await self.repo.update(
                candidate, review_passed=True, status="awaiting_merge"
            )
            if candidate.policy["landing_actor"] == "platform":
                await self._enqueue(board, card, await self._repo_for_card(board, card))
        await self._publish(candidate)
        return await self._status(board, card)

    async def _attempt_context_change(self, board, card, candidate, attempt, execution):
        from app.services.completion_context import (
            changed_context_sources,
            completion_context_manifest,
            completion_execution_context,
        )

        try:
            kind, role, dispatch, checks = await self._role(board, candidate)
            if (kind, role, dispatch.provider, dispatch.model) != (
                attempt.kind,
                attempt.role,
                attempt.provider,
                attempt.model,
            ):
                return "completion_role_changed", None
            _, binding = await completion_execution_context(
                self.db,
                board,
                card,
                candidate,
                execution,
                dispatch,
                kind=kind,
                role=role,
                source_sha=attempt.source_sha,
                checks=checks,
                public_candidate=self._public_candidate(candidate),
            )
        except ConflictError as exc:
            if exc.error_code not in {
                "completion_context_too_large",
                "completion_prompt_render_invalid",
                "completion_role_prompt_required",
                "completion_role_unconfigured",
                "completion_role_model_required",
                "completion_role_tool_policy_invalid",
            }:
                raise
            return exc.error_code, None
        if attempt.context_hash != digest(binding):
            manifest = await completion_context_manifest(
                self.db, board, dispatch, binding, card=card
            )
            return "completion_context_changed", changed_context_sources(
                attempt.context_manifest, manifest
            )
        return None, None

    @staticmethod
    def _rejection_receipt(attempt, code, retryable, changed_sources=None):
        receipt = {
            "attempt_id": str(attempt.id),
            "status": "rejected",
            "code": code,
            "retryable": retryable,
            "next_action": "retry_completion" if retryable else "inspect_completion",
        }
        if changed_sources is not None:
            receipt["changed_sources"] = changed_sources
        return receipt

    async def _result_status(self, board, card, attempt):
        response = await self._status(board, card)
        receipt = (attempt.result or {}).get("receipt")
        if receipt:
            response["result_receipt"] = receipt
        return response

    async def _reject_result(
        self,
        board,
        card,
        candidate,
        attempt,
        execution,
        result_data,
        code,
        *,
        retryable,
        changed_sources=None,
    ):
        was_active = attempt.status == "claimed"
        receipt = (attempt.result or {}).get("receipt") or self._rejection_receipt(
            attempt,
            code,
            retryable,
            changed_sources,
        )
        await self.repo.update(
            attempt,
            status="rejected",
            completed_at=naive_now(),
            result_hash=digest(result_data),
            result={**result_data, "receipt": receipt},
        )
        await self.repo.update(
            execution,
            status=ExecutionStatus.aborted,
            completed_at=naive_now(),
            output_summary=result_data["summary"],
            error_message=receipt["code"],
            tokens_used=result_data["tokens_used"],
            cost_usd=result_data["cost_usd"],
            duration_seconds=result_data["duration_seconds"],
        )
        if retryable and was_active:
            await self.repo.update(
                candidate,
                status="failed",
                failed_kind=attempt.kind,
                summary=code,
            )
        await self._publish(candidate)
        # Returning a rejected receipt commits the retirement through get_db.
        # Throwing a conflict here would roll back the lease and usage together.
        return await self._result_status(board, card, attempt)

    async def _publish(self, candidate):
        await event_bus.publish(
            "completion.updated",
            {
                "board_id": str(candidate.board_id),
                "card_id": str(candidate.card_id),
                "candidate_id": str(candidate.id),
                "status": candidate.status,
            },
            workspace_id=candidate.workspace_id,
        )
