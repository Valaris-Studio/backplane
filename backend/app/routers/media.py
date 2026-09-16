# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.config import settings
from app.core.workspace import WorkspaceContext, get_workspace
from app.services.gcs import GCSService

router = APIRouter(
    prefix="/api/workspaces/{slug}/media",
    tags=["media"],
)


class MediaUploadRequest(BaseModel):
    filename: str
    content_type: str


class MediaUploadResponse(BaseModel):
    upload_url: str
    public_url: str


@router.post("/upload-url", response_model=MediaUploadResponse)
async def get_media_upload_url(
    data: MediaUploadRequest,
    ctx: WorkspaceContext = Depends(get_workspace),
):
    gcs_path = f"media/{ctx.workspace.id}/{uuid.uuid4()}/{data.filename}"
    if not settings.GCS_BUCKET:
        return MediaUploadResponse(
            upload_url=f"/api/local-storage/upload/{gcs_path}",
            public_url=f"/api/local-storage/download/{gcs_path}",
        )
    gcs = GCSService(settings.GCS_BUCKET, settings.GCS_SA_EMAIL)
    upload_url = gcs.generate_upload_url(gcs_path, data.content_type)
    if not upload_url:
        # GCS credentials unavailable — fall back to local storage
        return MediaUploadResponse(
            upload_url=f"/api/local-storage/upload/{gcs_path}",
            public_url=f"/api/local-storage/download/{gcs_path}",
        )
    download_url = gcs.generate_download_url(gcs_path)
    if not download_url:
        return MediaUploadResponse(
            upload_url=f"/api/local-storage/upload/{gcs_path}",
            public_url=f"/api/local-storage/download/{gcs_path}",
        )
    return MediaUploadResponse(upload_url=upload_url, public_url=download_url)
