# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_member,
    resolve_board_id,
)
from app.database import get_db
from app.schemas.kanban.card import (
    BulkCardCreate,
    BulkCardCreateResponse,
    CardClaimRequest,
    CardCreate,
    CardFormat,
    CardMoveRequest,
    CardRead,
    CardSummary,
    CardUpdate,
    ParticipantAdd,
)
from app.services.kanban.card import CardService

router = APIRouter(prefix="/api/workspaces/{slug}/boards/{board_id}/cards", tags=["cards"])


@router.get("/search", response_model=list[CardRead] | list[CardSummary])
async def search_cards(
    q: str | None = Query(default=None),
    priority: str | None = Query(default=None),
    card_type: str | None = Query(default=None),
    status: str | None = Query(default=None),
    label: str | None = Query(default=None),
    has_assignee: bool | None = Query(default=None),
    assignee_id: uuid.UUID | None = Query(default=None),
    column_id: uuid.UUID | None = Query(default=None),
    column_type: str | None = Query(default=None),
    exclude_column_type: str | None = Query(default=None),
    include_untyped: bool | None = Query(default=None),
    overdue: bool | None = Query(default=None),
    all_dependencies_done: bool = Query(default=False),
    summary_only: bool = Query(
        default=False,
        description="Return compact cards (identity/column/classification only) "
        "instead of full CardRead payloads.",
    ),
    limit: int = Query(default=50, le=100),
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    cards = await service.search_cards(
        board_id,
        ctx.workspace.id,
        q=q,
        priority=priority,
        card_type=card_type,
        status=status,
        label=label,
        has_assignee=has_assignee,
        assignee_id=assignee_id,
        column_id=column_id,
        column_type=column_type,
        exclude_column_type=exclude_column_type,
        include_untyped=True if include_untyped is None else include_untyped,
        overdue=overdue,
        all_dependencies_done=all_dependencies_done,
        limit=limit,
    )
    if summary_only:
        return [CardSummary.model_validate(c) for c in cards]
    return cards


@router.get("/resolve", response_model=CardRead)
async def resolve_card_by_prefix(
    prefix: str = Query(..., description="UUID prefix fragment (min 4 chars)."),
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    # Registered BEFORE GET /{card_id} so the literal 'resolve' segment is never
    # shadowed by the UUID path param (FastAPI matches in declaration order).
    service = CardService(db)
    return await service.resolve_card_by_prefix(
        board_id, prefix, workspace_id=ctx.workspace.id
    )


@router.post("", response_model=CardRead, status_code=201)
async def create_card(
    data: CardCreate,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    return await service.create_card(board_id, data, ctx.user.id, workspace_id=ctx.workspace.id)


@router.post("/bulk", response_model=BulkCardCreateResponse, status_code=201)
async def bulk_create_cards(
    data: BulkCardCreate,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    cards = await service.bulk_create_cards(
        board_id, data.cards, ctx.user.id, workspace_id=ctx.workspace.id,
    )
    return BulkCardCreateResponse(created=len(cards), cards=cards)


@router.get("/{card_id}", response_model=CardRead)
async def get_card(
    card_id: uuid.UUID,
    format: CardFormat = Query(
        default=CardFormat.prosemirror,
        description="`prosemirror` (default, stored value) or `markdown`.",
    ),
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    return await service.get_card(
        card_id, board_id, as_markdown=format == CardFormat.markdown
    )


@router.patch("/{card_id}", response_model=CardRead)
async def update_card(
    card_id: uuid.UUID,
    data: CardUpdate,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    return await service.update_card(
        card_id, board_id, data, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )


@router.delete("/{card_id}", status_code=204)
async def delete_card(
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    await service.delete_card(
        card_id, board_id, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )


@router.patch("/{card_id}/move", response_model=CardRead)
async def move_card(
    card_id: uuid.UUID,
    data: CardMoveRequest,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    return await service.move_card(
        card_id, board_id, data, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )


@router.post("/{card_id}/participants", response_model=CardRead, status_code=201)
async def add_participant(
    card_id: uuid.UUID,
    data: ParticipantAdd,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    return await service.add_participant(
        card_id, board_id, data.user_id, data.role,
        workspace_id=ctx.workspace.id, actor_id=ctx.user.id,
        agent_id=data.agent_id,
        pipeline_role=data.pipeline_role,
    )


@router.delete("/{card_id}/participants/{user_id}", response_model=CardRead | None)
async def remove_participant(
    card_id: uuid.UUID,
    user_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    card = await service.remove_participant(
        card_id, board_id, user_id,
        workspace_id=ctx.workspace.id, actor_id=ctx.user.id,
    )
    if card is None:
        return Response(status_code=204)
    return card


@router.delete(
    "/{card_id}/participants/by-pipeline-role/{pipeline_role}",
    response_model=CardRead | None,
)
async def remove_participants_by_pipeline_role(
    card_id: uuid.UUID,
    pipeline_role: str,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    card = await service.remove_participants_by_pipeline_role(
        card_id, board_id, pipeline_role,
        workspace_id=ctx.workspace.id, actor_id=ctx.user.id,
    )
    if card is None:
        return Response(status_code=204)
    return card


@router.post("/{card_id}/claim", response_model=CardRead)
async def claim_card(
    card_id: uuid.UUID,
    data: CardClaimRequest,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = CardService(db)
    return await service.claim_card(
        card_id, board_id, data.agent_id,
        workspace_id=ctx.workspace.id, actor_id=ctx.user.id,
    )
