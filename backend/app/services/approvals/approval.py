# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import logging
import uuid
from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.core.event_bus import event_bus
from app.exceptions import ConflictError, ResourceNotFoundError
from app.models.approvals.approval import ApprovalCategory, ApprovalStatus
from app.repositories.approvals.approval import ApprovalRepository
from app.schemas.approvals.approval import ApprovalCreate, ApprovalDecide
from app.services.approvals.risk import AUTO_APPROVE_THRESHOLD, compute_risk_score
from app.utils import utcnow

logger = logging.getLogger(__name__)


class ApprovalService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = ApprovalRepository(db)

    async def create_approval(self, workspace_id: uuid.UUID, data: ApprovalCreate):
        risk_score = compute_risk_score(data.category, data.action_payload)
        status = (
            ApprovalStatus.auto_approved
            if risk_score <= AUTO_APPROVE_THRESHOLD
            else ApprovalStatus.pending
        )

        approval = await self.repo.create(
            agent_id=data.agent_id,
            workspace_id=workspace_id,
            board_id=data.board_id,
            category=data.category,
            action_description=data.action_description,
            action_payload=data.action_payload,
            risk_score=risk_score,
            status=status,
            execution_id=data.execution_id,
            expires_at=utcnow() + timedelta(hours=24),
        )

        try:
            await event_bus.publish(
                event_type=events.APPROVAL_CREATED,
                payload={
                    "approval_id": str(approval.id),
                    "status": status.value,
                    "category": data.category.value,
                    "risk_score": risk_score,
                    "action_description": data.action_description,
                    "agent_id": str(data.agent_id),
                },
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish APPROVAL_CREATED event")

        # Re-fetch to load agent relationship for agent_name (eager-loaded).
        result = await self.repo.get_by_id(approval.id)

        # INV-2: a pending approval is the "waiting-on-a-human" signal — notify
        # the workspace deciders. agent_owner_id lets generation skip a re-fetch
        # and also include the agent's human owner. agent is eager-loaded so
        # reading created_by_id here never lazy-loads (lazy="raise").
        if result.status == ApprovalStatus.pending:
            await self._notify(
                workspace_id=workspace_id,
                board_id=result.board_id,
                category="approval_requested",
                actor_id=None,
                agent_id=result.agent_id,
                agent_owner_id=result.agent.created_by_id if result.agent else None,
                entity_id=result.id,
                dedupe_seed=str(result.id),
                action_description=data.action_description,
            )

        return result

    async def list_approvals(
        self,
        workspace_id: uuid.UUID,
        status: ApprovalStatus | None = None,
    ):
        return await self.repo.list_by_workspace(workspace_id, status)

    async def get_approval(self, approval_id: uuid.UUID, workspace_id: uuid.UUID):
        approval = await self.repo.get_by_id(approval_id)
        if not approval or approval.workspace_id != workspace_id:
            raise ResourceNotFoundError("Approval not found")
        return approval

    async def decide(
        self,
        approval_id: uuid.UUID,
        workspace_id: uuid.UUID,
        user_id: uuid.UUID,
        data: ApprovalDecide,
    ):
        approval = await self.repo.get_by_id(approval_id)
        if not approval or approval.workspace_id != workspace_id:
            raise ResourceNotFoundError("Approval not found")

        if approval.status != ApprovalStatus.pending:
            raise ConflictError(f"Approval already {approval.status.value}")

        handler = self._DECISION_HANDLERS.get(approval.category)
        if handler is not None:
            await handler(self, approval, user_id, data)
        else:
            await self._mark_decided(approval, user_id, data)
        # Re-fetch so the freshly-set decided_by relationship is eager-loaded
        # for decided_by_name (the row was loaded before user_id was assigned).
        result = await self.repo.get_by_id(approval_id)

        try:
            await event_bus.publish(
                event_type=events.APPROVAL_UPDATED,
                payload={
                    "approval_id": str(approval.id),
                    "status": data.decision.value,
                    "decided_by": str(user_id),
                    "decision_reason": data.reason,
                },
                workspace_id=workspace_id,
            )
        except Exception:
            logger.exception("Failed to publish APPROVAL_UPDATED event")

        # INV-2: notify the agent's owning human that their approval was decided.
        # The deciding admin is the actor and is suppressed by INV-3.
        await self._notify(
            workspace_id=workspace_id,
            board_id=result.board_id,
            category="approval_decided",
            actor_id=user_id,
            agent_id=result.agent_id,
            agent_owner_id=result.agent.created_by_id if result.agent else None,
            entity_id=result.id,
            dedupe_seed=f"{result.id}:{data.decision.value}",
            decision=data.decision.value,
        )

        return result

    async def _mark_decided(
        self, approval, user_id: uuid.UUID, data: ApprovalDecide
    ) -> None:
        await self.repo.update(
            approval,
            status=data.decision,
            decided_by_id=user_id,
            decided_at=utcnow(),
            decision_reason=data.reason,
        )

    async def _decide_skill_publication(
        self, approval, user_id: uuid.UUID, data: ApprovalDecide
    ) -> None:
        """Approving publishes the proposed skill version; rejecting marks it
        rejected — inline, in the SAME transaction as the status write (a
        background loop's bare async_session rolls back at close; see
        CLAUDE.md). No savepoint-swallow: if the effect fails, the decision
        must not persist either.
        """
        # Lazy import: SkillService imports the approvals create path for
        # proposals, so a module-level import here would be circular.
        from app.services.skills.skill_service import SkillService

        skill_service = SkillService(self.db)
        # action_payload is agent-supplied (request_approval takes an arbitrary
        # dict), so every key is untrusted: a malformed one must 404 like a
        # vanished referent, never surface as a 500 that strands the approval.
        payload = approval.action_payload or {}
        try:
            skill_id = uuid.UUID(str(payload.get("skill_id")))
            version_number = int(payload.get("version"))
        except (TypeError, ValueError):
            raise ResourceNotFoundError("Proposed skill no longer exists")

        skill = await skill_service.repo.get_by_id(skill_id)
        if skill is None or skill.workspace_id != approval.workspace_id:
            raise ResourceNotFoundError("Proposed skill no longer exists")
        version = await skill_service.versions.get_by_number(skill.id, version_number)
        if version is None:
            raise ResourceNotFoundError("Proposed skill version no longer exists")

        # Resolve-then-mutate: only now that the referent is known to exist
        # may the status flip — a failed hook leaves the approval pending.
        await self._mark_decided(approval, user_id, data)

        if data.decision == ApprovalStatus.approved:
            # Reuse the direct-publish semantics: version status, the skill's
            # latest_published_version, and the `published` activity — the
            # board history must not depend on which path published.
            await skill_service.record_approval(
                approval.workspace_id,
                skill.slug,
                version.version,
                user_id,
                approval_id=approval.id,
                reason=data.reason,
            )
            await skill_service.publish_version(
                approval.workspace_id,
                skill.slug,
                version.version,
                user_id,
                approval_id=approval.id,
                reason=data.reason,
            )
        elif data.decision == ApprovalStatus.rejected:
            await skill_service.reject_version(
                approval.workspace_id,
                skill.slug,
                version.version,
                user_id,
                approval_id=approval.id,
                reason=data.reason,
            )

    # One category, one handler — dispatched by decide after the pending
    # check, before the shared event publish + notify.
    _DECISION_HANDLERS = {
        ApprovalCategory.skill_publication: _decide_skill_publication,
    }

    async def _notify(
        self,
        *,
        workspace_id: uuid.UUID,
        board_id: uuid.UUID | None,
        category: str,
        actor_id: uuid.UUID | None,
        agent_id: uuid.UUID,
        agent_owner_id: uuid.UUID | None,
        entity_id: uuid.UUID,
        dedupe_seed: str,
        **extra_params,
    ) -> None:
        """Approvals bypass ActivityService, so they call generation directly
        (INV-2 second source path). In-txn; a failure is logged so a generation
        bug never rolls back the approval write."""
        from app.services.notifications.generation import NotificationService

        params = {
            "agent_id": str(agent_id),
            **(
                {"agent_owner_id": str(agent_owner_id)}
                if agent_owner_id is not None
                else {}
            ),
            **{k: v for k, v in extra_params.items() if v is not None},
        }
        # begin_nested() issues a SAVEPOINT around generation: on asyncpg a SQL
        # error inside a plain try/except aborts the WHOLE txn, so the outer
        # get_db commit would roll the approval write back. The savepoint scopes
        # a failure to the nested block, then the broad except swallows — the
        # approval stays durable even if a generation bug fires.
        try:
            async with self.db.begin_nested():
                await NotificationService(self.db).generate_for_event(
                    self.db,
                    workspace_id=workspace_id,
                    board_id=board_id,
                    category=category,
                    actor_id=actor_id,
                    is_agent_actor=False,
                    entity_type="approval",
                    entity_id=entity_id,
                    dedupe_seed=dedupe_seed,
                    params=params,
                    link={"kind": "approval", "approval_id": str(entity_id)},
                )
        except Exception:
            logger.exception(
                "notification generation failed for approval %s", entity_id
            )
