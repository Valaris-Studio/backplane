# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import current_agent_id, get_current_user
from app.core.workspace import enforce_agent_scope
from app.database import get_db
from app.exceptions import (
    ForbiddenError,
    PayloadTooLargeError,
    ResourceNotFoundError,
)
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember
from app.schemas.resources.resource import validate_storage_filename
from app.services.storage.local import hardened_file_response, local_storage_path

router = APIRouter(prefix="/api/local-storage", tags=["local-storage"])

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MiB — cap unbounded PUT buffering (DoS)


async def _read_capped_body(request: Request) -> bytes:
    """Buffer the request body, aborting at MAX_UPLOAD_BYTES.

    Rejects both an oversized declared Content-Length and a lying/absent one:
    the streamed read is tallied chunk-by-chunk so the cap holds regardless.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        raise PayloadTooLargeError("Upload exceeds size limit")

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_UPLOAD_BYTES:
            raise PayloadTooLargeError("Upload exceeds size limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def _enforce_tenancy(file_path: str, user: User, db: AsyncSession) -> None:
    """Allow only the two minted key shapes, then require workspace membership.

    The backend mints exactly `{workspace.id}/{uuid4}/{filename}` (resource
    uploads) and `media/{workspace.id}/{uuid4}/{filename}` (media); nothing
    else legitimate exists under LOCAL_STORAGE_DIR, so every other shape is
    refused outright. The previous scan-every-segment model stayed permissive
    when no segment resolved to a workspace, serving arbitrary non-traversal
    paths to any authed caller — agent allowlists never consulted. Keys minted
    before mint-time filename validation (20aae3ac) still exist, so this
    serving-side shape check stays the security boundary. Split on "/" as
    POSIX key segments, never Path: Path collapses `//` and is
    platform-dependent, and Windows self-hosters exist.
    """
    segments = file_path.split("/")
    if any(not segment for segment in segments):
        raise ForbiddenError("Invalid path")
    if len(segments) == 4 and segments[0] == "media":
        segments = segments[1:]
    if len(segments) != 3:
        raise ForbiddenError("Invalid path")
    workspace_segment, object_segment, filename = segments
    try:
        workspace_id = uuid.UUID(workspace_segment)
        uuid.UUID(object_segment)
        validate_storage_filename(filename)
    except ValueError:
        raise ForbiddenError("Invalid path") from None

    result = await db.execute(
        select(Workspace.slug).where(Workspace.id == workspace_id)
    )
    slug = result.scalar_one_or_none()
    if slug is None:
        raise ForbiddenError("Invalid path")

    result = await db.execute(
        select(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id,
            WorkspaceMember.user_id == user.id,
        )
    )
    if result.scalar_one_or_none() is None:
        raise ForbiddenError("Not a member of this workspace")
    # Membership is the user's, and an agent key resolves to its creating
    # user — so without this an agent reads and writes the bytes of every
    # workspace that user belongs to, whatever its allowlist says.
    await enforce_agent_scope(current_agent_id.get(), slug, db)


@router.put("/upload/{file_path:path}")
async def upload_file(
    file_path: str,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    await _enforce_tenancy(file_path, user, db)
    dest = local_storage_path(file_path)
    body = await _read_capped_body(request)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(body)
    return {"status": "ok"}


@router.get("/download/{file_path:path}")
async def download_file(
    file_path: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    await _enforce_tenancy(file_path, user, db)
    dest = local_storage_path(file_path)
    if not dest.is_file():
        raise ResourceNotFoundError("File not found")
    return hardened_file_response(dest, file_path.rsplit("/", 1)[-1])
