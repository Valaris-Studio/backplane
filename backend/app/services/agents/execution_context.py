# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Context refresh and retained invocation receipts for bound executions.

Authority for every write comes from the execution's immutable binding plus
the caller's and agent's CURRENT permissions — never from the scheduler hold
(long gone by a second model call), never from discover predicates (a claim
legitimately falsifies them), and never from the generic execution update's
typo fallback. Scheduler pause and board freeze do not stop in-flight work,
matching existing execution telemetry.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core import events
from app.exceptions import ConflictError, ResourceNotFoundError
from app.models.agents.context_receipt import (
    RECEIPT_STATUS_PREPARED,
    USE_NOT_VERIFIED,
    ExecutionContextBinding,
    ExecutionContextReceipt,
)
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.user import User
from app.models.workspace import Workspace
from app.repositories.agents.context_receipt import (
    ExecutionContextBindingRepository,
    ExecutionContextReceiptRepository,
)
from app.repositories.agents.agent import AgentRepository
from app.repositories.agents.execution import ExecutionRepository
from app.repositories.kanban.board import BoardRepository
from app.repositories.kanban.card import CardRepository
from app.schemas.agents.context import ContextReceiptCreate
from app.services.agents.context_assembly import (
    AssembledContext,
)
from app.services.agents.context_manifest import sha256_text, utf8_bytes
from app.services.agents.guarded_context_assembly import assemble_stage_context
from app.services.committed_events import queue_until_commit
from app.services.agents.identity import (
    verify_agent_may_work_in_workspace,
    verify_caller_owns_agent,
)
from app.services.workspace_config import WorkspaceConfigService

_ACTIVE_STATUSES = (ExecutionStatus.started, ExecutionStatus.running)
# The fields a reused request key must repeat exactly to replay its receipt.
_RETAINED_REQUEST_FIELDS = (
    "context_revision", "input_prompt", "system_prompt", "provider", "model",
)


def _execution_not_found() -> ResourceNotFoundError:
    return ResourceNotFoundError("Execution not found")


class ExecutionContextService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.executions = ExecutionRepository(db)
        self.bindings = ExecutionContextBindingRepository(db)
        self.receipts = ExecutionContextReceiptRepository(db)

    async def refresh(
        self, workspace: Workspace, execution_id: uuid.UUID, user: User
    ) -> tuple[AgentExecution, AssembledContext]:
        execution, binding = await self.authorize_bound(workspace, execution_id, user)
        return execution, await self._assemble(binding)

    async def prepare(
        self,
        workspace: Workspace,
        execution_id: uuid.UUID,
        user: User,
        data: ContextReceiptCreate,
    ) -> tuple[ExecutionContextReceipt, bool]:
        """Returns (receipt, created). Authority, the active binding and the
        context revision are validated after the execution-row wait and before
        assembly, replay or insert. That is not linearized through the
        response: a revocation committed later is not reflected, and a
        receipt is evidence of what was current then, never a dispatch permit."""
        await self.authorize_bound(workspace, execution_id, user)
        # Serializes preparations of one execution (ordinals) and orders them
        # against a concurrent terminal update. The wait is unbounded, so
        # everything authorized above is re-read under the lock.
        if await self.executions.get_for_update(execution_id) is None:
            raise _execution_not_found()
        _, binding = await self.authorize_bound(workspace, execution_id, user)

        assembled = await self._assemble(binding)
        if data.context_revision != assembled.revision:
            raise ConflictError(
                "The execution's context changed; refresh it and prepare again",
                error_code="execution_context_changed",
            )

        existing = await self.receipts.get_by_request(execution_id, data.client_request_id)
        if existing is None:
            receipt_id = await self.receipts.insert(
                execution_id=execution_id,
                ordinal=await self.receipts.next_ordinal(execution_id),
                client_request_id=data.client_request_id,
                context_revision=assembled.revision,
                context_manifest=assembled.manifest.model_dump(mode="json"),
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
            )
            if receipt_id is not None:
                receipt = await self.receipts.get(execution_id, receipt_id)
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
            existing = await self.receipts.get_by_request(
                execution_id, data.client_request_id
            )
        # A context-dispatch receipt is never an A1 replay: this route cannot
        # express its dispatch identity.
        if existing.dispatch is not None or any(
            getattr(existing, f) != getattr(data, f) for f in _RETAINED_REQUEST_FIELDS
        ):
            raise ConflictError(
                "This client_request_id already prepared a different invocation",
                error_code="context_receipt_conflict",
            )
        return existing, False

    async def list_receipts(
        self, workspace: Workspace, execution_id: uuid.UUID, *, limit: int, offset: int
    ) -> tuple[list[ExecutionContextReceipt], int]:
        await self._get_workspace_execution(workspace, execution_id)
        rows = await self.receipts.list_page(execution_id, limit=limit, offset=offset)
        return rows, await self.receipts.count(execution_id)

    async def get_receipt(
        self, workspace: Workspace, execution_id: uuid.UUID, receipt_id: uuid.UUID
    ) -> ExecutionContextReceipt:
        """Historical and immutable: readable by any current workspace member,
        independent of whether the execution could still prepare anything."""
        await self._get_workspace_execution(workspace, execution_id)
        receipt = await self.receipts.get(execution_id, receipt_id)
        if receipt is None:
            raise ResourceNotFoundError("Context receipt not found")
        return receipt

    async def _get_workspace_execution(
        self, workspace: Workspace, execution_id: uuid.UUID
    ) -> AgentExecution:
        # Unknown and other-workspace ids answer identically.
        execution = await self.executions.get_by_id(execution_id)
        if execution is None or execution.workspace_id != workspace.id:
            raise _execution_not_found()
        return execution

    async def authorize_bound(
        self, workspace: Workspace, execution_id: uuid.UUID, user: User
    ) -> tuple[AgentExecution, ExecutionContextBinding]:
        execution = await self._get_workspace_execution(workspace, execution_id)
        agent = await AgentRepository(self.db).get_current(execution.agent_id)
        if agent is None:
            raise _execution_not_found()
        # Only the bound agent itself (linked key) or its creator (plain key)
        # may act for it; other members can read history but not see this.
        verify_caller_owns_agent(
            agent, actor_id=user.id, foreign_user_error=_execution_not_found
        )
        await verify_agent_may_work_in_workspace(
            self.db,
            agent,
            workspace_slug=workspace.slug,
            workspace_id=workspace.id,
            caller_id=user.id,
        )
        binding = await self.bindings.get_by_execution(execution.id)
        if (
            binding is None
            or binding.agent_id != execution.agent_id
            or binding.workspace_id != workspace.id
        ):
            # Never inferred from cards_affected or a still-live hold.
            raise ConflictError(
                "This execution was started without an assignment binding; "
                "its context cannot be refreshed or recorded",
                error_code="execution_context_unbound",
            )
        self._require_active(execution)
        return execution, binding

    @staticmethod
    def _require_active(execution: AgentExecution | None) -> None:
        if execution is None:
            raise _execution_not_found()
        if execution.status not in _ACTIVE_STATUSES or execution.completed_at is not None:
            raise ConflictError(
                "The execution is no longer active; start a new assignment",
                error_code="execution_not_active",
            )

    async def _assemble(self, binding: ExecutionContextBinding) -> AssembledContext:
        card = await CardRepository(self.db).get_by_id(binding.card_id)
        board = await BoardRepository(self.db).get_by_id(binding.board_id)
        if (
            card is None
            or board is None
            or card.board_id != board.id
            or board.workspace_id != binding.workspace_id
        ):
            raise ConflictError(
                "The execution's bound card is no longer available",
                error_code="execution_context_unavailable",
            )
        # Current configuration for the bound role, never the assignment-time
        # copy: config-only edits must surface as a changed revision.
        config = await WorkspaceConfigService(self.db).get_config(
            binding.workspace_id, include_warnings=False
        )
        pipeline = config.get("pipeline_config") or {}
        stage = next(
            (s for s in pipeline.get("stages") or [] if s.get("role") == binding.role), None
        ) or {}
        return await assemble_stage_context(
            self.db,
            pipeline=pipeline,
            role=binding.role,
            workspace_id=binding.workspace_id,
            card=card,
            board=board,
            sources=(stage.get("llm") or {}).get("context_sources") or [],
            stage=stage,
        )
