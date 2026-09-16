# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_agent_callers
from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    get_workspace_member,
    get_workspace_owner,
    resolve_board_id,
)
from app.database import get_db
from app.schemas.kanban.board import (
    BoardCreate,
    BoardDetailRead,
    BoardRead,
    BoardUpdate,
)
from app.schemas.kanban.loop import (
    LoopBindingDiffRead,
    LoopBindingRead,
    LoopConfigPut,
    LoopConfigRead,
    LoopHistoryRead,
    LoopReadinessRead,
    LoopStatePatch,
    LoopStatusRead,
    LoopTransitionPage,
)
from app.services.kanban.board import BoardService
from app.services.kanban.card_excerpt import card_description_excerpt

router = APIRouter(prefix="/api/workspaces/{slug}/boards", tags=["boards"])


@router.get("", response_model=list[BoardRead])
async def list_boards(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.list_boards(ctx.workspace.id)


@router.post("", response_model=BoardDetailRead, status_code=201)
async def create_board(
    data: BoardCreate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    board = await service.create_board(ctx.workspace.id, data, ctx.user.id)
    # Re-fetch via the eager-loading detail path so the seeded columns
    # serialize without async lazy-load (MissingGreenlet) issues.
    return await service.get_full_board(board.id, ctx.workspace.id)


# Path segment accepts either a UUID or a slug. The service resolves in that order.
@router.get("/{board_id}", response_model=BoardDetailRead)
async def get_board(
    board_id: str,
    summary: bool = Query(
        default=False,
        description=(
            "Replace each card's description body with a short plain-text "
            "excerpt. The kanban board renders only that excerpt, so this "
            "drops the dominant term in the payload at 1000 cards. Default "
            "false — MCP get_board, the runner, and every existing client "
            "keep the full body."
        ),
    ),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    board = await service.get_board_by_identifier(board_id, ctx.workspace.id)
    if not summary:
        return board
    # Excerpt on the SERIALIZED copy, never the ORM instances: this request's
    # session auto-commits, so trimming card.description in place would persist
    # the truncation and destroy the stored bodies.
    detail = BoardDetailRead.model_validate(board)
    for column in detail.columns:
        for card in column.cards:
            card.description = card_description_excerpt(card.description)
    return detail


@router.patch(
    "/{board_id}",
    response_model=BoardRead,
    dependencies=[Depends(forbid_agent_callers)],
)
async def update_board(
    board_id: str,
    data: BoardUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    board = await service.get_board_by_identifier(board_id, ctx.workspace.id)
    return await service.update_board(
        board.id,
        ctx.workspace.id,
        data,
        actor_id=ctx.user.id,
        actor_role=ctx.membership.role,
    )


@router.post("/{board_id}/freeze", response_model=BoardRead)
async def freeze_board(
    board_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    board = await service.get_board_by_identifier(board_id, ctx.workspace.id)
    return await service.freeze_board(board.id, ctx.workspace.id, actor_id=ctx.user.id)


@router.post("/{board_id}/unfreeze", response_model=BoardRead)
async def unfreeze_board(
    board_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_owner),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    board = await service.get_board_by_identifier(board_id, ctx.workspace.id)
    return await service.unfreeze_board(
        board.id, ctx.workspace.id, actor_id=ctx.user.id
    )


# Loop-mode routes deliberately carry NO forbid_agent_callers: agents inherit
# their creating user's role, and a member-owned agent key must be able to
# flip the loop off autonomously (the loop's safety valve).


@router.get("/{board_id}/loop", response_model=LoopConfigRead)
async def get_board_loop(
    request: Request,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.get_loop_config(
        board_uuid, ctx.workspace.id,
        completion_protocol_version=request.headers.get("X-Backplane-Completion-Version"),
    )


@router.get("/{board_id}/loop/readiness", response_model=LoopReadinessRead)
async def get_board_loop_readiness(
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.get_loop_readiness(board_uuid, ctx.workspace.id)


@router.get("/{board_id}/loop/binding", response_model=LoopBindingRead)
async def get_board_loop_binding(
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    """The authoring state behind a bound board's prompts.

    A member read, not admin: seeing WHICH template a board runs is the same
    class of fact as seeing its prompts, which GET /loop already serves to any
    member. Only mutating the binding needs admin.
    """
    service = BoardService(db)
    return await service.get_loop_binding(board_uuid, ctx.workspace.id)


@router.get("/{board_id}/loop/binding/diff", response_model=LoopBindingDiffRead)
async def get_board_loop_binding_diff(
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    """What a re-render would change, for the drift banner's review step.

    Member-read for the same reason as /loop/binding: this is the board's own
    prompts, which GET /loop already serves to any member.
    """
    service = BoardService(db)
    return await service.get_loop_binding_diff(board_uuid, ctx.workspace.id)


@router.get("/{board_id}/loop/history", response_model=LoopHistoryRead)
async def get_board_loop_history(
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.get_loop_history(board_uuid, ctx.workspace.id)


@router.get("/{board_id}/loop/transitions", response_model=LoopTransitionPage)
async def get_board_loop_transitions(
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.get_loop_transitions(
        board_uuid, ctx.workspace.id, limit=limit, offset=offset
    )


@router.get("/{board_id}/loop/status", response_model=LoopStatusRead)
async def get_board_loop_status(
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.get_loop_status(board_uuid, ctx.workspace.id)


@router.put("/{board_id}/loop", response_model=LoopConfigRead)
async def put_board_loop(
    data: LoopConfigPut,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.put_loop_config(
        board_uuid, ctx.workspace.id, data, actor_id=ctx.user.id
    )


@router.patch("/{board_id}/loop/state", response_model=LoopConfigRead)
async def patch_board_loop_state(
    data: LoopStatePatch,
    board_uuid: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    return await service.set_loop_state(
        board_uuid, ctx.workspace.id, data, actor_id=ctx.user.id
    )


@router.delete(
    "/{board_id}", status_code=204, dependencies=[Depends(forbid_agent_callers)]
)
async def delete_board(
    board_id: str,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    service = BoardService(db)
    board = await service.get_board_by_identifier(board_id, ctx.workspace.id)
    await service.delete_board(board.id, ctx.workspace.id, actor_id=ctx.user.id)
