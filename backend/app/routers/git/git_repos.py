# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
    get_workspace_member,
    resolve_board_id,
)
from app.database import get_db
from app.exceptions import ForbiddenError
from app.models.workspace import WorkspaceRole
from app.schemas.git.git_repo import GitRepoCreate, GitRepoRead, GitRepoUpdate
from app.services.git.git_repo import GitRepoService

router = APIRouter(
    prefix="/api/workspaces/{slug}/boards/{board_id}/git-repos",
    tags=["git-repos"],
)


def _require_admin_to_bind_connection(ctx: WorkspaceContext) -> None:
    """Binding a repo to a credential is an admin act.

    It chooses which workspace token the merge queue embeds into this repo's
    clone URL, so it is a privilege grant, not a repo detail. Linking a repo
    with no connection stays member-level — that path grants nothing.
    """
    if ctx.membership.role not in (WorkspaceRole.owner, WorkspaceRole.admin):
        raise ForbiddenError(
            "Binding a git repo to a workspace credential requires the admin "
            "or owner role."
        )


@router.get("", response_model=list[GitRepoRead])
async def list_git_repos(
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = GitRepoService(db)
    return await service.list_git_repos(board_id)


@router.post("", response_model=GitRepoRead)
async def create_git_repo(
    data: GitRepoCreate,
    response: Response,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    if data.connection_id is not None:
        _require_admin_to_bind_connection(ctx)
    service = GitRepoService(db)
    repo, created = await service.create_git_repo(
        board_id, ctx.workspace.id, data, ctx.user.id
    )
    response.status_code = 201 if created else 200
    return repo


@router.get("/{repo_ident}", response_model=GitRepoRead)
async def get_git_repo(
    repo_ident: str,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = GitRepoService(db)
    return await service.get_git_repo_by_identifier(repo_ident, board_id)


@router.put("/{repo_ident}", response_model=GitRepoRead)
async def update_git_repo(
    repo_ident: str,
    data: GitRepoUpdate,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    # Presence, not truthiness: clearing a binding (connection_id=null) is the
    # same privilege as setting one — it silently moves the repo onto whatever
    # credential the resolver falls back to.
    if "connection_id" in data.model_dump(exclude_unset=True):
        _require_admin_to_bind_connection(ctx)
    service = GitRepoService(db)
    existing = await service.get_git_repo_by_identifier(repo_ident, board_id)
    return await service.update_git_repo(
        existing.id,
        board_id,
        data,
        workspace_id=ctx.workspace.id,
        actor_id=ctx.user.id,
    )


@router.delete("/{repo_ident}", status_code=204)
async def delete_git_repo(
    repo_ident: str,
    board_id: uuid.UUID = Depends(resolve_board_id),
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    service = GitRepoService(db)
    existing = await service.get_git_repo_by_identifier(repo_ident, board_id)
    await service.delete_git_repo(
        existing.id, board_id, workspace_id=ctx.workspace.id, actor_id=ctx.user.id
    )
