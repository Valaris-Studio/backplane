# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.agents.context import (
    CONTEXT_DISPATCH_HEADER,
    ContextBindingRead,
    DispatchContextRead,
    DispatchPreparationAck,
    DispatchPreparationCreate,
    InvocationKind,
    PromptSlot,
    ContextReceiptCreate,
    ContextReceiptRead,
    ContextReceiptSummary,
    ExecutionContextRead,
)
from app.services.agents.context_dispatch import require_supported_header
from app.services.agents.dispatch_context import DispatchContextService
from app.services.agents.execution_context import ExecutionContextService

router = APIRouter(
    prefix="/api/workspaces/{slug}/executions/{execution_id}",
    tags=["agent-executions"],
)

_BOUND_EXECUTION_RESPONSES = {
    403: {"description": "Caller or bound agent is no longer authorized."},
    404: {"description": "Unknown execution, or not the caller's agent."},
    409: {
        "description": (
            "execution_context_unbound, execution_not_active, "
            "execution_context_unavailable, execution_context_changed; with a "
            "configured context budget also context_budget_invalid, "
            "context_selection_changed or context_budget_exceeded (bounded "
            "budget/diagnostics/source admission in `context`, no note bodies)."
        )
    },
}


@router.get(
    "/context",
    response_model=ExecutionContextRead,
    responses=_BOUND_EXECUTION_RESPONSES,
)
async def refresh_execution_context(
    execution_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Current context for this bound, active execution — a refresh within
    the same execution, not a new scheduler assignment."""
    execution, assembled = await ExecutionContextService(db).refresh(
        ctx.workspace, execution_id, ctx.user
    )
    return ExecutionContextRead(
        execution_id=execution.id,
        context=assembled.context,
        context_manifest=assembled.manifest,
        context_revision=assembled.revision,
    )


@router.post(
    "/context-receipts",
    response_model=ContextReceiptRead,
    status_code=201,
    responses={200: {"model": ContextReceiptRead}, **_BOUND_EXECUTION_RESPONSES},
)
async def prepare_context_receipt(
    execution_id: uuid.UUID,
    data: ContextReceiptCreate,
    response: Response,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Retain one invocation's exact prompt and the server's manifest of its
    context. Status `prepared`: this records input, not a provider run. An
    identical retry returns the same receipt with 200."""
    receipt, created = await ExecutionContextService(db).prepare(
        ctx.workspace, execution_id, ctx.user, data
    )
    if not created:
        response.status_code = 200
    return receipt


@router.get("/context-receipts", response_model=list[ContextReceiptSummary])
async def list_context_receipts(
    execution_id: uuid.UUID,
    response: Response,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """Newest invocation first. Bare array; the unpaged total rides
    `X-Total-Count`."""
    receipts, total = await ExecutionContextService(db).list_receipts(
        ctx.workspace, execution_id, limit=limit, offset=offset
    )
    response.headers["X-Total-Count"] = str(total)
    return receipts


@router.get("/context-receipts/{receipt_id}", response_model=ContextReceiptRead)
async def get_context_receipt(
    execution_id: uuid.UUID,
    receipt_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await ExecutionContextService(db).get_receipt(
        ctx.workspace, execution_id, receipt_id
    )


_DISPATCH_RESPONSES = {
    403: {"description": "Caller or bound agent is no longer authorized."},
    404: {"description": "Unknown execution, or not the caller's agent."},
    409: {
        "description": (
            "execution_context_unbound, execution_not_active, execution_context_unavailable, "
            "context_dispatch_version_required, context_dispatch_version_unsupported, "
            "execution_dispatch_unavailable, context_budget_invalid (bounded findings), "
            "context_budget_exceeded (reason required_source or invocation_bytes), "
            "execution_context_changed, execution_dispatch_changed or "
            "context_receipt_conflict."
        )
    },
    422: {
        "description": (
            "Invalid payload or invocation, required_context_missing, "
            "required_context_not_verbatim or context_dispatch_declaration_invalid."
        )
    },
}


@router.get(
    "/dispatch-context",
    response_model=DispatchContextRead,
    responses=_DISPATCH_RESPONSES,
)
async def get_dispatch_context(
    execution_id: uuid.UUID,
    response: Response,
    invocation_kind: InvocationKind,
    prompt_slot: PromptSlot,
    step_name: str | None = Query(None, min_length=1, max_length=255),
    context_dispatch_header: str | None = Header(None, alias=CONTEXT_DISPATCH_HEADER),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Fresh context-dispatch v1 snapshot for one invocation of this bound,
    active execution: current context, card, template and dispatch settings
    for the bound role's exact step or auxiliary slot. The caller names the
    invocation; configuration — never the caller — supplies its target."""
    require_supported_header(context_dispatch_header)
    snapshot = await DispatchContextService(db).snapshot(
        ctx.workspace, execution_id, ctx.user,
        kind=invocation_kind, step_name=step_name, prompt_slot=prompt_slot,
    )
    response.headers[CONTEXT_DISPATCH_HEADER] = "1"
    return DispatchContextRead(
        protocol_version=1,
        mode=snapshot.mode,
        execution_id=snapshot.execution.id,
        context_binding=ContextBindingRead.model_validate(snapshot.binding),
        invocation=snapshot.invocation.as_dict(),
        context=snapshot.assembled.context,
        context_manifest=snapshot.assembled.manifest,
        context_revision=snapshot.assembled.revision,
        dispatch_revision=snapshot.dispatch_revision,
        card=snapshot.card,
        dispatch=snapshot.dispatch,
    )


@router.post(
    "/dispatch-preparations",
    response_model=DispatchPreparationAck,
    status_code=201,
    responses={200: {"model": DispatchPreparationAck}, **_DISPATCH_RESPONSES},
)
async def prepare_dispatch(
    execution_id: uuid.UUID,
    data: DispatchPreparationCreate,
    response: Response,
    context_dispatch_header: str | None = Header(None, alias=CONTEXT_DISPATCH_HEADER),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Acknowledge one complete invocation after verifying every required
    context block verbatim in its exact prompt bytes. The acknowledgement is
    only valid once returned: it is sent after the request transaction
    commits. `prepared`/`not_verified`: retained input, not provider use."""
    require_supported_header(context_dispatch_header)
    receipt, created = await DispatchContextService(db).prepare(
        ctx.workspace, execution_id, ctx.user, data
    )
    response.status_code = 201 if created else 200
    response.headers[CONTEXT_DISPATCH_HEADER] = "1"
    return DispatchPreparationAck(
        protocol_version=1,
        acknowledged="prepared",
        receipt_id=receipt.id,
        execution_id=receipt.execution_id,
        client_request_id=receipt.client_request_id,
        ordinal=receipt.ordinal,
        context_revision=receipt.context_revision,
        dispatch_revision=receipt.dispatch["dispatch_revision"],
        prompt_sha256=receipt.prompt_sha256,
        prompt_bytes=receipt.prompt_bytes,
        system_prompt_sha256=receipt.system_prompt_sha256,
        system_prompt_bytes=receipt.system_prompt_bytes,
        inclusion_verification=receipt.dispatch["inclusion_verification"],
        use_verification=receipt.use_verification,
    )
