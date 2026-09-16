# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Workspace-scoped git connection CRUD + repo picker.

The OAuth dance lives in oauth_github.py; this router exposes what the
frontend Settings page needs after the connection exists:
  - list / delete connections
  - list authenticated user's repositories via a stored connection
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app import config as _config
from app.core.workspace import (
    WorkspaceContext,
    get_workspace,
    get_workspace_admin,
)
from app.database import get_db
from app.integrations.git.adapters.github import GitHubAdapter
from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_repo import GitProvider
from app.schemas.git.git_connection import (
    GitConnectionPatCreate,
    GitConnectionRead,
    GitConnectionVerifyResult,
)
from app.schemas.git.git_connection_repository import (
    RepositoryPage,
    RepositoryRead,
)
from app.services.git.forge_probe import ForgeProbe, get_forge_probe
from app.services.git.git_connection import GitConnectionService

router = APIRouter(
    prefix="/api/workspaces/{slug}/git-connections",
    tags=["integrations-git-connections"],
)


def _service(db: AsyncSession) -> GitConnectionService:
    return GitConnectionService(
        db, vault=FernetTokenVault(_config.settings.INTEGRATIONS_TOKEN_KEY.encode())
    )


@router.get("", response_model=list[GitConnectionRead])
async def list_git_connections(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    return await _service(db).list_connections(ctx.workspace.id)


@router.post("", response_model=GitConnectionRead)
async def create_git_connection_from_token(
    data: GitConnectionPatCreate,
    response: Response,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
    probe: ForgeProbe = Depends(get_forge_probe),
):
    connection, created = await _service(db).create_pat_connection(
        workspace_id=ctx.workspace.id,
        data=data,
        actor_id=ctx.user.id,
        probe=probe,
    )
    response.status_code = 201 if created else 200
    return connection


@router.post("/{connection_id}/verify", response_model=GitConnectionVerifyResult)
async def verify_git_connection(
    connection_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
    probe: ForgeProbe = Depends(get_forge_probe),
):
    return await _service(db).verify_connection(
        connection_id=connection_id,
        workspace_id=ctx.workspace.id,
        probe=probe,
    )


@router.delete("/{connection_id}", status_code=204)
async def delete_git_connection(
    connection_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_admin),
    db: AsyncSession = Depends(get_db),
):
    await _service(db).delete_connection(
        connection_id, ctx.workspace.id, actor_id=ctx.user.id
    )
    return Response(status_code=204)


@router.get("/{connection_id}/repositories", response_model=RepositoryPage)
async def list_repositories_for_connection(
    connection_id: uuid.UUID,
    cursor: str | None = Query(default=None),
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = _service(db)
    connection = await service.repo.get_by_id(connection_id)
    if connection is None or connection.workspace_id != ctx.workspace.id:
        from app.exceptions import ResourceNotFoundError

        raise ResourceNotFoundError("Git connection not found")
    access_token = await service.get_decrypted_access_token(
        connection_id, ctx.workspace.id
    )
    adapter = _build_adapter(connection.provider, access_token, connection.base_url)
    items, next_cursor = await adapter.list_repositories(cursor=cursor)
    return RepositoryPage(
        items=[
            RepositoryRead(
                provider=item.provider,
                id=item.id,
                full_name=item.full_name,
                default_branch=item.default_branch,
                private=item.private,
                clone_url_https=item.clone_url_https,
                updated_at=item.updated_at,
            )
            for item in items
        ],
        next_cursor=next_cursor,
    )


def _build_adapter(provider: str, access_token: str, base_url: str | None):
    if provider == GitProvider.github.value:
        return GitHubAdapter(access_token=access_token, base_url=base_url)
    # GitLab / Bitbucket adapters land in Sprint 4/5 — until then, the
    # connection model accepts the value but the picker can't use it.
    from app.exceptions import BadRequestError

    raise BadRequestError(f"Repository picker not implemented for provider {provider!r}")
