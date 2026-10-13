# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Context-dispatch v1: a fresh per-invocation snapshot and strict preparation.

Both routes rebuild the snapshot from CURRENT configuration through one code
path, so a preparation is checked against exactly what a refresh would show
now. A committed preparation proves the server retained these exact bytes and
found every required block in them — not that a provider ran, received the
bytes or used them (`use_verification: not_verified`).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.exceptions import ConflictError, ResourceNotFoundError, ValidationError
from app.models.agents.context_receipt import (
    RECEIPT_STATUS_PREPARED,
    USE_NOT_VERIFIED,
    ExecutionContextBinding,
    ExecutionContextReceipt,
)
from app.models.agents.execution import AgentExecution
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.schemas.agents.context import (
    CONTEXT_DISPATCH_VERSION,
    DispatchPreparationCreate,
)
from app.schemas.kanban.card import CardRead
from app.services.agents.context_assembly import (
    AssembledContext,
    context_source_alias,
)
from app.services.agents.guarded_context_assembly import assemble_for_invocation
from app.services.agents.context_dispatch import ContextDispatchPolicyService
from app.services.agents.context_dispatch_policy import LEGACY, REQUIRED
from app.services.agents.context_manifest import canonical_json, sha256_text, utf8_bytes
from app.services.agents.dispatch_inclusion import verify_inclusion
from app.services.agents.execution_context import ExecutionContextService
from app.services.agents.named_step import (
    MAIN_SLOT,
    Invocation,
    InvocationInvalid,
    InvocationUnavailable,
    NamedStep,
    parse_invocation,
    resolve_named_step,
)
from app.services.agents.prompt_config import PromptConfigService, post_process_kind_for
from app.services.committed_events import queue_until_commit
from app.services.kanban.card import attach_agent_presence, attach_pending_approvals
from app.services.llm_tiers import is_tier
from app.services.scheduling.dispatch_resolver import resolve_model_intent
from app.services.workspace_config import WorkspaceConfigService

_DISPATCH_REVISION_DOMAIN = "backplane.dispatch-config.v1\0"


def _unavailable(reason: str) -> ConflictError:
    # The reason names configuration, never template or note content.
    return ConflictError(
        f"This invocation cannot be dispatched with the current configuration: {reason}",
        error_code="execution_dispatch_unavailable",
    )


def _check_invocation_cap(assembled: AssembledContext, data: DispatchPreparationCreate) -> None:
    """The exact final UTF-8 input + explicit system, after every caller
    addition (repeated blocks, resume and operator text included). Nothing is
    trimmed to fit, and a refusal consumes no request key."""
    budget = assembled.manifest.budget
    if budget is None:
        return
    prompt_bytes = utf8_bytes(data.input_prompt)
    system_bytes = utf8_bytes(data.system_prompt)
    limit = budget.policy.max_invocation_bytes
    if prompt_bytes + system_bytes > limit:
        raise ConflictError(
            "The final prompt and system text exceed the invocation byte limit",
            error_code="context_budget_exceeded",
            context={
                "reason": "invocation_bytes",
                "limit": limit,
                "prompt_bytes": prompt_bytes,
                "system_prompt_bytes": system_bytes,
                "total_bytes": prompt_bytes + system_bytes,
                "policy_sha256": budget.policy_sha256,
            },
        )


def _invocation_location(pipeline: dict, named: NamedStep) -> tuple[int, int | None]:
    """Indices of the resolved stage and step, for budget layer paths. The
    resolver already proved the role's stage (and named step) unique."""
    stage_index = next(
        i for i, stage in enumerate(pipeline["stages"])
        if isinstance(stage, dict) and stage.get("role") == named.role
    )
    if named.step is None:
        return stage_index, None
    lifecycle = pipeline["stages"][stage_index]["lifecycle"]
    return stage_index, next(
        i for i, step in enumerate(lifecycle)
        if isinstance(step, dict) and step.get("name") == named.step.get("name")
    )


@dataclass(frozen=True)
class DispatchSnapshot:
    execution: AgentExecution
    binding: ExecutionContextBinding
    mode: str
    invocation: Invocation
    assembled: AssembledContext
    required: list[bool]
    card: dict[str, Any]
    dispatch: dict[str, Any]
    dispatch_revision: str


class DispatchContextService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.context = ExecutionContextService(db)

    async def snapshot(
        self,
        workspace: Workspace,
        execution_id: uuid.UUID,
        user: User,
        *,
        kind: str,
        step_name: str | None,
        prompt_slot: str,
    ) -> DispatchSnapshot:
        invocation = self._parse(kind, step_name, prompt_slot)
        execution, binding = await self.context.authorize_bound(workspace, execution_id, user)
        return await self._resolve(workspace, execution, binding, invocation)

    async def prepare(
        self,
        workspace: Workspace,
        execution_id: uuid.UUID,
        user: User,
        data: DispatchPreparationCreate,
    ) -> tuple[ExecutionContextReceipt, bool]:
        """Returns (receipt, created). Authority, the binding floor and both
        revisions are re-validated after the execution-row wait and before
        replay or insert; the caller's transaction owns commit and event."""
        invocation = self._parse(
            data.invocation.kind, data.invocation.step_name, data.invocation.prompt_slot
        )
        await self.context.authorize_bound(workspace, execution_id, user)
        if await self.context.executions.get_for_update(execution_id) is None:
            raise ResourceNotFoundError("Execution not found")
        execution, binding = await self.context.authorize_bound(workspace, execution_id, user)
        snapshot = await self._resolve(workspace, execution, binding, invocation)

        if data.context_revision != snapshot.assembled.revision:
            raise ConflictError(
                "The execution's context changed; refresh it and prepare again",
                error_code="execution_context_changed",
            )
        if data.dispatch_revision != snapshot.dispatch_revision:
            raise ConflictError(
                "The invocation's dispatch configuration changed; refresh and render again",
                error_code="execution_dispatch_changed",
            )
        self._check_declared_intent(data, snapshot.dispatch)

        detail_identity = self._declared_dispatch(data, invocation)
        existing = await self.context.receipts.get_by_request(execution_id, data.client_request_id)
        if existing is not None:
            return self._replay(existing, data, detail_identity), False

        _check_invocation_cap(snapshot.assembled, data)
        inclusion = verify_inclusion(
            list(snapshot.assembled.blocks),
            snapshot.required,
            [source.alias for source in snapshot.assembled.manifest.sources],
            input_prompt=data.input_prompt,
            system_prompt=data.system_prompt,
        )
        if inclusion.missing_required:
            # Indices only: an error must never echo context bodies.
            raise ValidationError(
                "A required context block is not present verbatim in the prompt",
                error_code="required_context_not_verbatim",
                error_params={"source_indices": inclusion.missing_required},
            )
        summary = {
            **{k: detail_identity[k] for k in ("protocol_version", "dispatch_revision", "invocation")},
            "inclusion_verification": (
                "required_blocks_exact" if any(snapshot.required) else "no_required_sources"
            ),
            "injected_bytes": inclusion.injected_bytes,
        }
        detail = {
            **detail_identity,
            **summary,
            "required_source_indices": snapshot.dispatch["required_source_indices"],
            "source_inclusions": inclusion.source_inclusions,
        }
        receipt_id = await self.context.receipts.insert(
            execution_id=execution_id,
            ordinal=await self.context.receipts.next_ordinal(execution_id),
            client_request_id=data.client_request_id,
            context_revision=snapshot.assembled.revision,
            context_manifest=snapshot.assembled.manifest.model_dump(mode="json"),
            input_prompt=data.input_prompt,
            system_prompt=data.system_prompt,
            prompt_sha256=sha256_text(data.input_prompt),
            prompt_bytes=utf8_bytes(data.input_prompt),
            system_prompt_sha256=sha256_text(data.system_prompt),
            system_prompt_bytes=utf8_bytes(data.system_prompt),
            provider=data.provider,
            model=data.model,
            status=RECEIPT_STATUS_PREPARED,
            use_verification=USE_NOT_VERIFIED,
            dispatch=detail,
            dispatch_summary=summary,
        )
        if receipt_id is None:
            # A concurrent request committed this key while we waited.
            existing = await self.context.receipts.get_by_request(execution_id, data.client_request_id)
            return self._replay(existing, data, detail_identity), False
        receipt = await self.context.receipts.get(execution_id, receipt_id)
        queue_until_commit(
            self.db,
            events.EXECUTION_CONTEXT_RECEIPT_CREATED,
            {
                "execution_id": str(execution_id),
                "workspace_id": str(workspace.id),
                "receipt_id": str(receipt.id),
                "ordinal": receipt.ordinal,
            },
            workspace.id,
        )
        return receipt, True

    # ------------------------------------------------------------------ parts

    @staticmethod
    def _parse(kind: str, step_name: str | None, prompt_slot: str) -> Invocation:
        try:
            return parse_invocation(kind, step_name, prompt_slot)
        except InvocationInvalid as exc:
            raise ValidationError(str(exc), error_code="execution_dispatch_invalid_invocation") from exc

    @staticmethod
    def _declared_dispatch(data: DispatchPreparationCreate, invocation: Invocation) -> dict[str, Any]:
        """The caller-declared dispatch identity retained on the receipt."""
        return {
            "protocol_version": data.protocol_version,
            "dispatch_revision": data.dispatch_revision,
            "invocation": invocation.as_dict(),
            "adapter": data.adapter,
            "resolution_kind": data.resolution_kind,
            "resume_session_id": data.resume_session_id,
            "channel_contract": data.channel_contract.model_dump(mode="json"),
        }

    @staticmethod
    def _replay(
        existing: ExecutionContextReceipt, data: DispatchPreparationCreate, identity: dict[str, Any]
    ) -> ExecutionContextReceipt:
        retained = existing.dispatch or {}
        same = existing.dispatch is not None and all(
            getattr(existing, field) == getattr(data, field)
            for field in ("context_revision", "input_prompt", "system_prompt", "provider", "model")
        ) and all(retained.get(key) == value for key, value in identity.items())
        if not same:
            raise ConflictError(
                "This client_request_id already prepared a different invocation",
                error_code="context_receipt_conflict",
            )
        return existing

    @staticmethod
    def _check_declared_intent(data: DispatchPreparationCreate, dispatch: dict[str, Any]) -> None:
        if data.resolution_kind == "pinned":
            consistent = (data.provider, data.model) == (dispatch["provider"], dispatch["model"])
        else:
            # A tier lets the runner's own mapping choose; the receipt keeps
            # both, but a tier name is not an actual model.
            consistent = bool(dispatch["tier"]) and not is_tier(data.model)
        if not consistent:
            raise ValidationError(
                "The declared provider/model does not match this invocation's dispatch intent",
                error_code="context_dispatch_declaration_invalid",
            )

    async def _resolve(
        self,
        workspace: Workspace,
        execution: AgentExecution,
        binding: ExecutionContextBinding,
        invocation: Invocation,
    ) -> DispatchSnapshot:
        stamp = binding.context_dispatch
        if stamp is None:
            raise ConflictError(
                "This execution was started without context-dispatch negotiation",
                error_code="context_dispatch_version_required",
            )
        current = await ContextDispatchPolicyService(self.db).current_mode(
            binding.workspace_id, binding.agent_id
        )
        # A bound floor never downgrades; current policy can only raise it.
        mode = REQUIRED if REQUIRED in (stamp["mode"], current) else LEGACY

        config = await WorkspaceConfigService(self.db).get_config(
            binding.workspace_id, include_warnings=False
        )
        pipeline = config.get("pipeline_config") or {}
        try:
            named = resolve_named_step(pipeline, role=binding.role, invocation=invocation)
        except InvocationUnavailable as exc:
            raise _unavailable(str(exc)) from exc

        card = await CardRepository(self.db).get_by_id(binding.card_id)
        board = await BoardRepository(self.db).get_by_id(binding.board_id)
        if card is None or board is None or card.board_id != board.id or board.workspace_id != binding.workspace_id:
            raise ConflictError(
                "The execution's bound card is no longer available",
                error_code="execution_context_unavailable",
            )

        target_role, target_stage = named.prompt_target
        post_process_kind = (
            named.llm.get("post_process_kind") or ""
            if invocation.prompt_slot == MAIN_SLOT
            else post_process_kind_for(pipeline, target_role, target_stage)
        )
        prompt = await PromptConfigService(self.db).effective_prompt(
            binding.workspace_id, team_role=target_role, stage=target_stage,
            post_process_kind=post_process_kind,
        )
        if prompt is None:
            raise _unavailable("no authored prompt for the invocation's target")

        stage_index, step_index = _invocation_location(pipeline, named)
        assembled = await assemble_for_invocation(
            self.db,
            pipeline=pipeline,
            stage_index=stage_index,
            step_index=step_index,
            sources=named.context_sources,
            workspace_id=binding.workspace_id,
            card=card,
            board=board,
            stage=named.stage,
        )
        # Same skip rule as the assembler, so flags align with manifest order.
        required = [
            source.get("required") is True
            for source in named.context_sources
            if context_source_alias(source) is not None
        ]
        if any(flag and block == "" for flag, block in zip(required, assembled.blocks, strict=True)):
            raise ValidationError(
                "A required context source rendered empty",
                error_code="required_context_missing",
            )

        provider, model, tier = resolve_model_intent(
            named.llm.get("provider") or "", named.llm.get("model") or "",
            workspace_id=binding.workspace_id,
        )
        tool_policy = named.llm.get("tool_policy")
        deny = tool_policy.get("deny") if isinstance(tool_policy, dict) else None
        dispatch = {
            "provider": provider,
            "model": model,
            "tier": tier,
            "prompt_slug": prompt.slug,
            "prompt_target": {"role": target_role, "stage": target_stage},
            "input_template": prompt.resolved_content,
            "system_template": "",
            "tool_policy": {"deny": list(deny or [])},
            "output_schema": named.llm.get("output_schema") or "",
            "flags": {
                "post_process_kind": post_process_kind,
                "approval_enabled": named.llm.get("approval_enabled") is True,
                "inject_directives": named.llm.get("inject_directives"),
                "use_minimal_prompt_when_unauthored": named.llm.get("use_minimal_prompt_when_unauthored"),
            },
            "tools": named.llm.get("tools"),
            "required_source_indices": [i for i, flag in enumerate(required) if flag],
        }

        await attach_pending_approvals(self.db, [card], workspace_id=binding.workspace_id)
        await attach_agent_presence(self.db, [card])
        card_read = CardRead.model_validate(card).model_dump(mode="json")
        revision = sha256_text(_DISPATCH_REVISION_DOMAIN + canonical_json({
            "protocol_version": CONTEXT_DISPATCH_VERSION,
            "mode": mode,
            "binding": {
                "execution_id": str(execution.id), "agent_id": str(binding.agent_id),
                "workspace_id": str(binding.workspace_id), "board_id": str(binding.board_id),
                "card_id": str(binding.card_id), "role": binding.role,
            },
            "invocation": invocation.as_dict(),
            "dispatch": dispatch,
            "required": required,
            "budget_layers": list(named.budget_layers),
            # The whole advertised CardRead: any field may be a template input,
            # so even liveness/display fields invalidate a stale preparation
            # (the runner's one refresh-and-retry absorbs that churn).
            "card": card_read,
        }))
        return DispatchSnapshot(
            execution=execution, binding=binding, mode=mode, invocation=invocation,
            assembled=assembled, required=required, card=card_read,
            dispatch=dispatch, dispatch_revision=revision,
        )
