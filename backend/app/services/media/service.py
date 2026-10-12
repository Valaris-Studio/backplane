# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Durable, authenticated access to stored media and resource files.

Callers reach these methods only through `Depends(get_workspace)`, so the
workspace is already authorised; every object key is rebuilt from that
workspace, never from the URL, so another tenant's key cannot be expressed.
Everything that is not a servable file in this workspace — a malformed id,
an invalid filename, a folder, a deleted or foreign resource, a missing
object — answers with the same 404 so none of them can be told apart.
"""

import datetime
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.exceptions import (
    BadRequestError,
    ResourceNotFoundError,
    StorageBackendUnavailableError,
    ValidationError,
)
from app.models.workspace import Workspace
from app.schemas.resources.resource import validate_storage_filename
from app.exceptions import StorageUnavailableError
from app.models.resources.resource import Resource
from app.services.gcs import (
    DEFAULT_DOWNLOAD_URL_TTL,
    ObjectStoreUnavailableError,
    get_gcs_service,
)
from app.services.media.links import media_content_path, resource_content_path
from app.services.media.signed_url_cache import SIGNED_URL_TTL_SECONDS, signed_url_cache
from app.services.resources.resource import ResourceService
from app.services.storage.local import (
    content_disposition,
    existing_local_file,
    is_inline_safe_image,
)

STORED_FILE_NOT_FOUND = "File not found"


def stored_file_not_found() -> ResourceNotFoundError:
    return ResourceNotFoundError(STORED_FILE_NOT_FOUND)


@dataclass(frozen=True)
class StoredFileTarget:
    filename: str
    redirect_url: str | None = None
    local_path: Path | None = None


@dataclass(frozen=True)
class ResourceDownloadLink:
    download_url: str
    content_url: str
    expires_in: int | None


@dataclass(frozen=True)
class MediaUpload:
    upload_url: str
    public_url: str


def media_object_key(workspace_id: uuid.UUID, object_id: uuid.UUID, filename: str) -> str:
    return f"media/{workspace_id}/{object_id}/{filename}"


class MediaService:
    def __init__(self, db: AsyncSession):
        self.db = db

    def mint_upload(self, workspace: Workspace, filename: str, content_type: str) -> MediaUpload:
        object_id = uuid.uuid4()
        key = media_object_key(workspace.id, object_id, filename)
        public_url = media_content_path(workspace.slug, object_id, filename)
        if not settings.GCS_BUCKET:
            return MediaUpload(upload_url=f"/api/local-storage/upload/{key}", public_url=public_url)
        upload_url = get_gcs_service().generate_upload_url(key, content_type)
        if not upload_url:
            # Never fall back to local disk here: on Cloud Run it is ephemeral,
            # so the upload would vanish with the next revision.
            raise StorageBackendUnavailableError()
        return MediaUpload(upload_url=upload_url, public_url=public_url)

    def resource_download_link(self, workspace: Workspace, resource: Resource) -> ResourceDownloadLink:
        """The shipped /download-url answer, plus the durable link to embed.

        Its 501 on unsignable storage is that endpoint's existing contract."""
        content_url = resource_content_path(workspace.slug, resource.id)
        if not settings.GCS_BUCKET:
            return ResourceDownloadLink(
                download_url=f"/api/local-storage/download/{resource.gcs_path}",
                content_url=content_url,
                expires_in=None,
            )
        download_url = get_gcs_service().generate_download_url(resource.gcs_path)
        if not download_url:
            raise StorageUnavailableError("GCS credentials unavailable")
        return ResourceDownloadLink(
            download_url=download_url,
            content_url=content_url,
            expires_in=int(DEFAULT_DOWNLOAD_URL_TTL.total_seconds()),
        )

    async def media_content(
        self, workspace: Workspace, object_id: str, filename: str
    ) -> StoredFileTarget:
        try:
            parsed_object_id = uuid.UUID(object_id)
            if validate_storage_filename(filename) != filename:
                raise ValueError("filename is not in stored form")
        except ValueError:
            raise stored_file_not_found() from None
        key = media_object_key(workspace.id, parsed_object_id, filename)
        return await self._serve(key, filename)

    async def resource_content(self, workspace: Workspace, resource_id: str) -> StoredFileTarget:
        try:
            parsed_resource_id = uuid.UUID(resource_id)
        except ValueError:
            raise stored_file_not_found() from None
        try:
            # Its 400 (folder / no file) and 422 (foreign legacy key) stay the
            # contract of /download-url; here they collapse into the 404.
            resource = await ResourceService(self.db).get_resource_for_signing(
                parsed_resource_id, workspace.id
            )
        except (BadRequestError, ResourceNotFoundError, ValidationError):
            raise stored_file_not_found() from None
        return await self._serve(resource.gcs_path, resource.gcs_path.rsplit("/", 1)[-1])

    async def _serve(self, key: str, filename: str) -> StoredFileTarget:
        if not settings.GCS_BUCKET:
            return self._serve_local(key, filename)

        cached_url = signed_url_cache.get(key)
        if cached_url is not None:
            return StoredFileTarget(filename=filename, redirect_url=cached_url)

        gcs = get_gcs_service()
        try:
            stat = await run_in_threadpool(gcs.stat_object, key)
        except ObjectStoreUnavailableError:
            return self._serve_local(key, filename, unavailable=True)
        if stat is None:
            # Uploads that hit the old silent local-disk fallback live here.
            return self._serve_local(key, filename)

        disposition = (
            None if is_inline_safe_image(filename) else content_disposition(filename, inline=False)
        )
        signed_url = await run_in_threadpool(
            lambda: gcs.generate_download_url(
                key,
                expiration=datetime.timedelta(seconds=SIGNED_URL_TTL_SECONDS),
                content_disposition=disposition,
            )
        )
        if not signed_url:
            return self._serve_local(key, filename, unavailable=True)
        signed_url_cache.put(key, signed_url)
        return StoredFileTarget(filename=filename, redirect_url=signed_url)

    @staticmethod
    def _serve_local(key: str, filename: str, *, unavailable: bool = False) -> StoredFileTarget:
        local_path = existing_local_file(key)
        if local_path is not None:
            return StoredFileTarget(filename=filename, local_path=local_path)
        if unavailable:
            raise StorageBackendUnavailableError()
        raise stored_file_not_found()
