# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, Depends
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.convertors import PathConvertor, register_url_convertor

from app.core.workspace import WorkspaceContext, get_workspace
from app.database import get_db
from app.schemas.resources.resource import validate_storage_filename
from app.services.media.service import MediaService, StoredFileTarget
from app.services.media.signed_url_cache import REDIRECT_MAX_AGE_SECONDS
from app.services.storage.local import hardened_file_response


class NonEmptyPathConvertor(PathConvertor):
    # Starlette's `path` also matches "", so `…/media/<id>` (no filename) was
    # redirect_slashes-307'd to `…/media/<id>/` before auth ran; requiring a
    # character makes it an unknown route (plain 404) instead.
    regex = ".+"


register_url_convertor("nonempty_path", NonEmptyPathConvertor())

router = APIRouter(
    prefix="/api/workspaces/{slug}/media",
    tags=["media"],
)


class MediaUploadRequest(BaseModel):
    filename: str
    content_type: str

    @field_validator("filename")
    @classmethod
    def validate_filename(cls, v: str) -> str:
        return validate_storage_filename(v)


class MediaUploadResponse(BaseModel):
    upload_url: str
    # Relative, stable app path to store in rich text; never a signed URL.
    public_url: str


def stored_file_response(target: StoredFileTarget) -> Response:
    if target.redirect_url is not None:
        return RedirectResponse(
            target.redirect_url,
            status_code=302,
            headers={"Cache-Control": f"private, max-age={REDIRECT_MAX_AGE_SECONDS}"},
        )
    return hardened_file_response(target.local_path, target.filename)


@router.post("/upload-url", response_model=MediaUploadResponse)
async def get_media_upload_url(
    data: MediaUploadRequest,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    upload = MediaService(db).mint_upload(ctx.workspace, data.filename, data.content_type)
    return MediaUploadResponse(upload_url=upload.upload_url, public_url=upload.public_url)


# `object_id` is a plain str and `filename` a path param on purpose: typed or
# single-segment params would let FastAPI answer a malformed id (422) or an
# encoded slash (routing 404) differently from a missing object.
@router.get(
    "/{object_id}/{filename:nonempty_path}",
    response_class=Response,
    responses={302: {"description": "Redirect to a short-lived signed URL"}},
)
async def get_media_content(
    object_id: str,
    filename: str,
    ctx: WorkspaceContext = Depends(get_workspace),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    target = await MediaService(db).media_content(ctx.workspace, object_id, filename)
    return stored_file_response(target)
