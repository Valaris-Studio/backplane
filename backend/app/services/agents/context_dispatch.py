# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Context-dispatch v1 policy: negotiation, floors and protected config writes.

The backend owns the policy; runners only negotiate it. Three rules carry
the security weight:

- Only a CURRENT human workspace admin/owner may change protected context
  policy (enrollment, required sources, budget opt-ins, auxiliary prompt
  slots), whatever the path: PATCH, full replacement, bundle preview/apply or
  a direct service call. An agent-linked key can carry its owner's admin
  role, so the route's admin check alone is not enough.
- A floor raise is refused while affected legacy card work is active, and a
  start serializes against such writes (see lock_dispatch_policy), so no
  legacy start can slip into a required cohort.
- No API here revokes provider credentials a runner already holds locally;
  activating a cohort still requires stopping/draining old processes.
"""

from __future__ import annotations

import copy
import dataclasses
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import current_agent_id
from app.exceptions import (
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.agents.agent import Agent
from app.models.workspace import Workspace, WorkspaceRole
from app.repositories.agents.agent import AgentRepository
from app.repositories.agents.execution import ExecutionRepository
from app.repositories.agents.prompt_config import PromptConfigRepository
from app.repositories.workspace import WorkspaceMemberRepository, WorkspaceRepository
from app.repositories.workspace_config import WorkspaceConfigRepository
from app.schemas.agents.context import (
    CONTEXT_DISPATCH_VERSION,
    ContextDispatchContractRead,
    ContextDispatchStamp,
)
from app.services.agents.context_budget import (
    bounded_write_findings,
    invalid_persisted_budget,
    validate_pipeline_budgets,
)
from app.services.agents.context_dispatch_policy import (
    REQUIRED,
    PolicyScan,
    auxiliary_slots_needed,
    canonical_agent_id,
    has_protected_policy,
    protected_projection,
    scan_policy,
)
from app.services.agents.identity import (
    verify_agent_may_work_in_workspace,
    verify_caller_owns_agent,
)
from app.services.pipeline_config_validation import (
    ValidationError as Finding,
)
from app.services.pipeline_config_validation import canonicalize_pipeline_config

_SUPPORTED_HEADER = str(CONTEXT_DISPATCH_VERSION)


def _version_unsupported() -> ValidationError:
    # 422 like any malformed wire value: nothing is negotiated by coercion.
    return ValidationError(
        "Only context-dispatch protocol version 1 is supported",
        error_code="context_dispatch_version_unsupported",
    )


def _version_required() -> ConflictError:
    return ConflictError(
        "This agent requires context-dispatch v1: negotiate the agent's "
        "context-dispatch contract and send context_dispatch_version",
        error_code="context_dispatch_version_required",
    )


def require_supported_header(header: str | None) -> None:
    if header is not None and header != _SUPPORTED_HEADER:
        raise _version_unsupported()


def negotiated_version(header: str | None, body_version: int | None) -> int | None:
    """The body is the acknowledgement; the header alone proves nothing (a
    proxy can add or keep it), but a present header must agree."""
    require_supported_header(header)
    if body_version is not None and body_version != CONTEXT_DISPATCH_VERSION:
        raise _version_unsupported()
    if header is not None and body_version is None:
        raise _version_required()
    return body_version


def negotiate(
    scan: PolicyScan,
    *,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    version: int | None,
    policy_revision: str | None,
) -> ContextDispatchStamp | None:
    """The stamp for a negotiated call, None for an allowed legacy call."""
    mode = scan.mode_for(agent_id)
    if version is None:
        if mode == REQUIRED:
            raise _version_required()
        return None
    if scan.budget_findings:
        # A persisted policy that no longer resolves assigns/starts nothing.
        raise invalid_persisted_budget(list(scan.budget_findings))
    current = scan.policy_revision(workspace_id=workspace_id, agent_id=agent_id)
    if policy_revision != current:
        raise ConflictError(
            "The context-dispatch policy changed; negotiate the contract again",
            error_code="context_dispatch_policy_changed",
        )
    return ContextDispatchStamp(version=CONTEXT_DISPATCH_VERSION, mode=mode, policy_revision=current)


def _scan_with_budgets(pipeline: dict | None) -> PolicyScan:
    scan = scan_policy(pipeline)
    if not scan.budgets:
        return scan
    findings = validate_pipeline_budgets(pipeline, settings.CONTEXT_BUDGET_CEILINGS, echo_keys=False)
    return dataclasses.replace(scan, budget_findings=tuple(findings))


def _finding(code: str, field: str, message: str, value=None) -> Finding:
    return Finding(code=code, field=field, message=message, value=value)


class ContextDispatchPolicyService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.config_repo = WorkspaceConfigRepository(db)

    async def _scan(self, workspace_id: uuid.UUID) -> PolicyScan:
        config = await self.config_repo.get_by_workspace(workspace_id)
        return _scan_with_budgets(config.pipeline_config if config else None)

    async def serialized_scan(self, workspace_id: uuid.UUID) -> PolicyScan:
        """Current policy, read after any in-flight policy write committed.
        Either the write then sees work this transaction commits, or this
        transaction sees the committed write — never neither."""
        await self.config_repo.lock_dispatch_policy(workspace_id, exclusive=False)
        config = await self.config_repo.get_fresh(workspace_id)
        return _scan_with_budgets(config.pipeline_config if config else None)

    async def lock_shared(self, workspace_id: uuid.UUID) -> None:
        await self.config_repo.lock_dispatch_policy(workspace_id, exclusive=False)

    async def lock_for_policy_write(self, workspace_id: uuid.UUID) -> None:
        await self.config_repo.lock_dispatch_policy(workspace_id, exclusive=True)

    async def _authorized_agent(
        self, workspace_id: uuid.UUID, workspace_slug: str, agent_id: uuid.UUID, user_id: uuid.UUID | None
    ) -> Agent:
        """Current authority, re-read fresh (in place for any instance the
        caller already holds): active, scoped here, owner and caller members."""
        agent = await AgentRepository(self.db).get_current(agent_id)
        if agent is None:
            raise ResourceNotFoundError("Agent not found", error_code="agent_not_found")
        verify_caller_owns_agent(agent, actor_id=user_id)
        await verify_agent_may_work_in_workspace(
            self.db, agent, workspace_slug=workspace_slug,
            workspace_id=workspace_id, caller_id=user_id,
        )
        return agent

    async def contract(
        self, workspace: Workspace, agent_id: uuid.UUID, user_id: uuid.UUID, *, header: str | None
    ) -> ContextDispatchContractRead:
        require_supported_header(header)
        await self._authorized_agent(workspace.id, workspace.slug, agent_id, user_id)
        scan = await self._scan(workspace.id)
        mode = scan.mode_for(agent_id)
        return ContextDispatchContractRead(
            agent_id=agent_id,
            workspace_id=workspace.id,
            policy_revision=scan.policy_revision(workspace_id=workspace.id, agent_id=agent_id),
            mode=mode,
            minimum_version=1 if mode == REQUIRED else 0,
        )

    async def negotiate_assignment(
        self,
        workspace: Workspace,
        agent: Agent,
        user_id: uuid.UUID,
        *,
        header: str | None,
        version: int | None,
        policy_revision: str | None,
    ) -> ContextDispatchStamp | None:
        """Every poll waits for in-flight policy writes, then re-checks the
        agent's CURRENT authority — legacy polls included, since the router
        loaded the agent before that unbounded wait. Enrollment never grants
        permission to run. Unversioned polls on a legacy floor then proceed
        as before."""
        verify_caller_owns_agent(agent, actor_id=user_id)
        scan = await self.serialized_scan(workspace.id)
        # Re-read in place (same identity-map instance as the router's), so a
        # pause, deactivation or descope committed during the wait is what
        # the scheduler sees.
        await self._authorized_agent(workspace.id, workspace.slug, agent.id, user_id)
        if header is None and version is None and scan.mode_for(agent.id) != REQUIRED:
            return None
        return negotiate(
            scan, workspace_id=workspace.id, agent_id=agent.id,
            version=negotiated_version(header, version), policy_revision=policy_revision,
        )

    async def stamp_for_start(
        self,
        workspace_id: uuid.UUID,
        agent_id: uuid.UUID,
        *,
        header: str | None,
        version: int | None,
        policy_revision: str | None,
    ) -> ContextDispatchStamp | None:
        """The caller must already hold the shared policy lock (taken before
        the hold lock); re-taking it here is a no-op for a shared holder."""
        return negotiate(
            await self.serialized_scan(workspace_id),
            workspace_id=workspace_id, agent_id=agent_id,
            version=negotiated_version(header, version), policy_revision=policy_revision,
        )

    async def refuse_unbound_card_start(
        self,
        workspace_id: uuid.UUID,
        workspace_slug: str,
        agent_id: uuid.UUID,
        user_id: uuid.UUID | None,
        *,
        header: str | None,
        version: int | None,
    ) -> None:
        """A card start without a hold can carry no binding, so it can never
        satisfy context dispatch (the legacy-bypass path). Authority is
        re-checked after the policy wait, which has no bound."""
        scan = await self.serialized_scan(workspace_id)
        await self._authorized_agent(workspace_id, workspace_slug, agent_id, user_id)
        if negotiated_version(header, version) is not None:
            raise ConflictError(
                "Context-dispatch work must start from its assignment hold "
                "(reservation_id) so the execution is bound",
                error_code="context_dispatch_binding_required",
            )
        if scan.mode_for(agent_id) == REQUIRED:
            raise _version_required()

    async def current_mode(self, workspace_id: uuid.UUID, agent_id: uuid.UUID) -> str:
        return (await self._scan(workspace_id)).mode_for(agent_id)

    # ---------------------------------------------------------- config writes

    async def _require_human_operator(self, workspace_id: uuid.UUID, actor_id: uuid.UUID | None) -> None:
        if current_agent_id.get() is not None or actor_id is None:
            raise ForbiddenError(
                "Only a human workspace admin may change context dispatch policy — not an agent key",
                error_code="admin_required",
            )
        role = await WorkspaceMemberRepository(self.db).current_role(workspace_id, actor_id)
        if role not in (WorkspaceRole.admin, WorkspaceRole.owner):
            raise ForbiddenError(
                "Only a current workspace admin or owner may change context dispatch policy",
                error_code="admin_required",
            )

    async def verify_current_config_writer(
        self, workspace_id: uuid.UUID, actor_id: uuid.UUID
    ) -> None:
        """Any actor-initiated config write, re-checked after its lock waits:
        the actor is a CURRENT admin/owner, and an agent-linked key's agent is
        still active and scoped here. Protected fields keep their separate
        human-only rule (_require_human_operator); this one admits agent keys."""
        role = await WorkspaceMemberRepository(self.db).current_role(workspace_id, actor_id)
        if role not in (WorkspaceRole.admin, WorkspaceRole.owner):
            raise ForbiddenError(
                "Only a current workspace admin or owner may change workspace configuration",
                error_code="admin_required",
            )
        agent_id = current_agent_id.get()
        if agent_id is not None:
            workspace = await WorkspaceRepository(self.db).get_by_id(workspace_id)
            await self._authorized_agent(workspace_id, workspace.slug, agent_id, actor_id)

    async def check_pipeline_write(
        self,
        workspace_id: uuid.UUID,
        old_pipeline: dict | None,
        new_pipeline: dict,
        actor_id: uuid.UUID | None,
    ) -> list[Finding]:
        """Authorize and validate a proposed full pipeline against the stored
        one. Raises 403 for an unauthorized protected change; returns blocking
        findings (the caller decides between 422 and a dry-run report)."""
        old_pipeline = old_pipeline if isinstance(old_pipeline, dict) else {}
        old_scan, new_scan = scan_policy(old_pipeline), scan_policy(new_pipeline)
        slots_matter = old_scan.any_floor or new_scan.any_floor
        if protected_projection(old_pipeline, include_prompt_slots=slots_matter) != protected_projection(
            new_pipeline, include_prompt_slots=slots_matter
        ):
            await self._require_human_operator(workspace_id, actor_id)

        findings: list[Finding] = []
        if "context_dispatch" in old_pipeline and "context_dispatch" not in new_pipeline:
            findings.append(_finding(
                "context_dispatch_removal_requires_explicit_empty", "context_dispatch",
                "This pipeline has a context_dispatch policy; set required_agent_ids to [] "
                "to disable future enrollment instead of omitting the block",
            ))
        findings += await self._unavailable_enrollment(workspace_id, old_pipeline, new_pipeline, actor_id)

        # The whole resolved policy is judged, not only changed blocks: a
        # lowered instance ceiling must not keep an invalid inherited value.
        findings += bounded_write_findings(
            validate_pipeline_budgets(new_pipeline, settings.CONTEXT_BUDGET_CEILINGS)
        )
        if new_scan.any_floor:
            findings += await self._auxiliary_prompt_findings(workspace_id, new_pipeline)
        return findings

    async def check_pipeline_reset(
        self, workspace_id: uuid.UUID, old_pipeline: dict | None, actor_id: uuid.UUID | None
    ) -> None:
        """An explicit null pipeline is a reset to platform defaults, never a
        way to drop protected policy: an agent key gets 403 like any other
        protected change, and a human operator must remove the policy
        deliberately (empty cohort, edited sources) before resetting."""
        if not has_protected_policy(old_pipeline):
            return
        await self._require_human_operator(workspace_id, actor_id)
        raise ValidationError(
            detail=[dict(_finding(
                "context_dispatch_policy_cannot_be_removed", "pipeline_config",
                "This pipeline holds context dispatch policy; a null pipeline cannot remove it",
            ))]
        )

    async def _unavailable_enrollment(
        self, workspace_id: uuid.UUID, old_pipeline: dict, new_pipeline: dict, actor_id: uuid.UUID | None
    ) -> list[Finding]:
        block = new_pipeline.get("context_dispatch")
        submitted = block.get("required_agent_ids") if isinstance(block, dict) else None
        if not isinstance(submitted, list):
            return []
        # Only new admissions are validated: an unchanged stale id (agent
        # since deleted or descoped) must not poison an unrelated edit.
        added = scan_policy(new_pipeline).enrolled - scan_policy(old_pipeline).enrolled
        if not added:
            return []
        slug = (await WorkspaceRepository(self.db).get_by_id(workspace_id)).slug
        enrollable = {
            str(i) for i in await AgentRepository(self.db).enrollable_ids(
                {uuid.UUID(i) for i in added}, owner_id=actor_id, workspace_slug=slug,
            )
        } if actor_id is not None else set()
        return [
            # One message for unknown, foreign-owned and out-of-scope ids:
            # the caller learns nothing about agents it does not own.
            _finding(
                "context_dispatch_agent_unavailable",
                f"context_dispatch.required_agent_ids[{index}]",
                "This agent cannot be enrolled by you in this workspace",
                value,
            )
            for index, value in enumerate(submitted)
            if canonical_agent_id(value) in added and canonical_agent_id(value) not in enrollable
        ]

    async def _auxiliary_prompt_findings(self, workspace_id: uuid.UUID, pipeline: dict) -> list[Finding]:
        prompts = PromptConfigRepository(self.db)
        findings = []
        for index, stage in enumerate(pipeline.get("stages") or []):
            if not isinstance(stage, dict) or not isinstance(stage.get("llm"), dict):
                continue
            slots = stage["llm"].get("prompt_slots")
            for slot in auxiliary_slots_needed(stage):
                target = slots.get(slot) if isinstance(slots, dict) else None
                resolvable = (
                    isinstance(target, dict)
                    and isinstance(target.get("role"), str) and bool(target["role"])
                    and isinstance(target.get("stage"), str) and bool(target["stage"])
                    and await prompts.effective_for_target(
                        workspace_id, target["role"], target["stage"]
                    ) is not None
                )
                if not resolvable:
                    findings.append(_finding(
                        "context_dispatch_prompt_unavailable",
                        f"stages[{index}].llm.prompt_slots.{slot}",
                        f"Required context dispatch needs a {slot!r} prompt mapping that "
                        "resolves to an authored prompt in this workspace",
                    ))
        return findings

    async def guard_floor_raise(
        self, workspace_id: uuid.UUID, old_pipeline: dict | None, new_pipeline: dict
    ) -> None:
        """Called under the config write locks. Refuses a write that would put
        still-running legacy card work under a required floor."""
        old_scan, new_scan = scan_policy(old_pipeline), scan_policy(new_pipeline)
        if new_scan.workspace_floor and not old_scan.workspace_floor:
            affected = None
        elif new_scan.workspace_floor:
            return
        else:
            affected = {uuid.UUID(i) for i in new_scan.enrolled - old_scan.enrolled}
            if not affected:
                return
        active = await ExecutionRepository(self.db).active_card_work_below_required_floor(
            workspace_id, affected
        )
        if active:
            raise ConflictError(
                "Legacy card work is still running for agents this change would "
                "require context dispatch from; drain it first",
                error_code="context_dispatch_legacy_execution_active",
                context={"active_executions": len(active)},
            )


def canonical_copy(pipeline: dict) -> dict:
    return canonicalize_pipeline_config(copy.deepcopy(pipeline))
