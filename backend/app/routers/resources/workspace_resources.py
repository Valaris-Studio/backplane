# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.workspace import WorkspaceContext, get_workspace, get_workspace_member
from app.database import get_db
from app.exceptions import StorageUnavailableError
from app.schemas.resources.resource import (
    DownloadUrlResponse,
    ResourceCreate,
    ResourceRead,
    ResourceUpdate,
    UploadUrlRequest,
    UploadUrlResponse,
)
from app.services.gcs import GCSService
from app.services.resources.resource import ResourceService

router = APIRouter(
    prefix="/api/workspaces/{slug}/resources",
    tags=["workspace-resources"],
)


@router.get("", response_model=list[ResourceRead])
async def list_workspace_resources(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
    parent_id: uuid.UUID | None = Query(None),
    q: str | None = Query(None, min_length=1, max_length=200),
    resource_type: str | None = Query(None, pattern="^(file|folder)$"),
    tag: str | None = Query(None, min_length=1, max_length=50),
):
    service = ResourceService(db)
    return await service.list_resources(
        workspace_id=ctx.workspace.id,
        parent_id=parent_id,
        q=q,
        resource_type=resource_type,
        tag=tag,
    )


@router.get("/tags", response_model=list[str])
async def list_workspace_tags(
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ResourceService(db)
    return await service.list_tags(ctx.workspace.id)


@router.post("", response_model=ResourceRead, status_code=201)
async def create_workspace_resource(
    data: ResourceCreate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = ResourceService(db)
    return await service.create_resource(ctx.workspace.id, data, ctx.user.id)


@router.post("/upload-url", response_model=UploadUrlResponse)
async def get_upload_url(
    data: UploadUrlRequest,
    ctx: WorkspaceContext = Depends(get_workspace),
):
    gcs_path = f"{ctx.workspace.id}/{uuid.uuid4()}/{data.filename}"
    if not settings.GCS_BUCKET:
        return UploadUrlResponse(
            upload_url=f"/api/local-storage/upload/{gcs_path}",
            gcs_path=gcs_path,
        )
    gcs = GCSService(settings.GCS_BUCKET, settings.GCS_SA_EMAIL)
    upload_url = gcs.generate_upload_url(gcs_path, data.content_type)
    if not upload_url:
        raise StorageUnavailableError("GCS credentials unavailable")
    return UploadUrlResponse(upload_url=upload_url, gcs_path=gcs_path)


@router.get("/{resource_id}", response_model=ResourceRead)
async def get_workspace_resource(
    resource_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ResourceService(db)
    return await service.get_resource(resource_id, ctx.workspace.id)


@router.get("/{resource_id}/download-url", response_model=DownloadUrlResponse)
async def get_download_url(
    resource_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db),
):
    service = ResourceService(db)
    resource = await service.get_resource_for_signing(resource_id, ctx.workspace.id)
    if not settings.GCS_BUCKET:
        return DownloadUrlResponse(
            download_url=f"/api/local-storage/download/{resource.gcs_path}"
        )
    gcs = GCSService(settings.GCS_BUCKET, settings.GCS_SA_EMAIL)
    download_url = gcs.generate_download_url(resource.gcs_path)
    if not download_url:
        raise StorageUnavailableError("GCS credentials unavailable")
    return DownloadUrlResponse(download_url=download_url)


@router.put("/{resource_id}", response_model=ResourceRead)
async def update_workspace_resource(
    resource_id: uuid.UUID,
    data: ResourceUpdate,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = ResourceService(db)
    return await service.update_resource(
        resource_id, ctx.workspace.id, ctx.user.id, data
    )


@router.delete("/{resource_id}", status_code=204)
async def delete_workspace_resource(
    resource_id: uuid.UUID,
    ctx: WorkspaceContext = Depends(get_workspace_member),
    db: AsyncSession = Depends(get_db),
):
    service = ResourceService(db)
    await service.delete_resource(resource_id, ctx.workspace.id, ctx.user.id)
