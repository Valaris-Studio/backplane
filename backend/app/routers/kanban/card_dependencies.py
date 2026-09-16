# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""REST surface for card_dependencies (DEP-3, spec note 233e4429 §A5).

URL: /api/workspaces/{slug}/boards/{board_id}/cards/{card_id}/dependencies

Idempotent semantics — see [[feedback_idempotent_mutations]]:
  POST on an existing edge returns 200 with the existing row.
  DELETE on a missing edge returns 204 (no-op success).
  PUT (bulk replace) is atomic — the whole set is validated before any
    mutation.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_member,
    resolve_board_id,
)
from app.database import get_db
from app.schemas.kanban.dependencies import (
    CardDependenciesView,
    CardDependencyBulkSet,
    CardDependencyCreate,
    CardDependencyRead,
)
from app.services.kanban.dependencies import DependencyService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/cards/{card_id}/dependencies",
    tags=["card-dependencies"],
)


def _to_read(dep) -> CardDependencyRead:
    return CardDependencyRead.model_validate(dep)


def _to_view(view) -> CardDependenciesView:
    return CardDependenciesView(
        ready=view.ready,
        depends_on=[_to_read(d) for d in view.depends_on],
        blocks=[_to_read(d) for d in view.blocks],
    )


@router.get("", response_model=CardDependenciesView)
async def list_dependencies(
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = DependencyService(db)
    view = await service.list_for_card(
        workspace_id=ctx.workspace.id, card_id=card_id, board_id=board_id
    )
    return _to_view(view)


@router.get("/status", response_model=CardDependenciesView)
async def dependency_status(
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    view = await DependencyService(db).list_for_card(
        workspace_id=ctx.workspace.id, card_id=card_id, board_id=board_id,
    )
    return _to_view(view)


@router.post("", response_model=CardDependencyRead)
async def add_dependency(
    response: Response,
    data: CardDependencyCreate,
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = DependencyService(db)
    # Check existing first so we can flip the status code 200 vs 201 to
    # signal idempotent re-adds without forking the service surface.
    existing = await service.repo.get(card_id, data.depends_on_card_id)
    dep = await service.add(
        workspace_id=ctx.workspace.id,
        card_id=card_id,
        depends_on_card_id=data.depends_on_card_id,
        actor_id=ctx.user.id,
        board_id=board_id,
    )
    response.status_code = 200 if existing is not None else 201
    return _to_read(dep)


@router.put("", response_model=CardDependenciesView)
async def bulk_set_dependencies(
    data: CardDependencyBulkSet,
    card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = DependencyService(db)
    view = await service.bulk_set(
        workspace_id=ctx.workspace.id,
        card_id=card_id,
        depends_on_card_ids=data.depends_on_card_ids,
        actor_id=ctx.user.id,
        board_id=board_id,
    )
    return _to_view(view)


@router.delete("/{depends_on_card_id}", status_code=204)
async def remove_dependency(
    card_id: uuid.UUID,
    depends_on_card_id: uuid.UUID,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = DependencyService(db)
    await service.remove(
        workspace_id=ctx.workspace.id,
        card_id=card_id,
        depends_on_card_id=depends_on_card_id,
        actor_id=ctx.user.id,
        board_id=board_id,
    )
