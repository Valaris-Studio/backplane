# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    Header,
    Query,
    Request,
    Response,
)
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app import database
from app.core.auth import forbid_credential_management, get_current_user
from app.core.companion_switch import require_companion_enabled
from app.core.private_route import PrivateRoute
from app.database import get_db
from app.exceptions import PayloadTooLargeError, ValidationError
from app.models.companion import CompanionInstallation
from app.models.user import User
from app.schemas.companion import (
    MAX_INGEST_BATCH_BYTES,
    AgentKeyCreated,
    AgentKeyRead,
    AutoMappingRequest,
    CapturePolicy,
    CapturePolicyUpdate,
    DeviceBoardList,
    DeviceIdentity,
    DeviceMappingRequest,
    DeviceMappingUpdate,
    DevicePolicy,
    DeviceSettingsUpdate,
    DeviceStatusReport,
    HeartbeatResult,
    InstallationCreate,
    InstallationEnrollment,
    InstallationRead,
    InstallationRename,
    MappingCreate,
    MappingRead,
    MappingUpdate,
    SessionDeletionResult,
    ingest_request_schema,
)
from app.schemas.session_content import (
    CAPABILITIES_HEADER,
    CHUNK_BYTES,
    CHUNK_DIGEST_HEADER,
    ChunkReceipt,
    ContentError,
    ContentUploadState,
    FinalizeRequest,
    RichIngestBatchSchema,
    RichIngestResult,
)
from app.schemas.agent_session import (
    AgentSessionPage,
    AgentSessionRead,
    SessionStatus,
    SessionUsageList,
)
from app.services.agent_session import AgentSessionService
from app.services.agent_session_ingest import (
    AgentSessionIngestService,
    validate_batch_shape,
)
from app.services.companion import CompanionService
from app.services.session_content_upload import (
    SessionContentUploadService,
    UploadRefusal,
)
from app.services.session_events import publish_invalidations
from app.services.session_search_index import SessionSearchObjectProcessor

router = APIRouter(
    prefix="/api/me/companion/installations",
    tags=["companion"],
    route_class=PrivateRoute,
    dependencies=[
        Depends(require_companion_enabled),
        Depends(forbid_credential_management),
    ],
)
device_router = APIRouter(
    prefix="/api/companion",
    tags=["companion-device"],
    route_class=PrivateRoute,
    dependencies=[Depends(require_companion_enabled)],
)


async def get_device_installation(
    request: Request, db: AsyncSession = Depends(get_db, scope="function")
) -> CompanionInstallation:
    """Device-token auth. `bpc_` tokens are accepted here and nowhere else."""
    installation = await CompanionService(db).authenticate_device(
        request.headers.get("Authorization", "")
    )
    # Lets the rate limiter keep this token's device budget (core/rate_limit.py).
    request.state.device_verified = True
    return installation


# --- human: installations, policy, mappings ---------------------------------


@router.post(
    "",
    response_model=InstallationEnrollment,
    status_code=201,
    responses={200: {"model": InstallationEnrollment}},
)
async def enroll_installation(
    data: InstallationCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Register this machine. The device token is returned once, on creation;
    retrying with the same installation_id returns 200 and no token."""
    enrollment, created = await CompanionService(db).enroll(user.id, data)
    if not created:
        response.status_code = 200
    return enrollment


@router.get("", response_model=list[InstallationRead])
async def list_installations(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).list_installations(user.id)


@router.get("/{installation_id}", response_model=InstallationRead)
async def get_installation(
    installation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).get_installation(user.id, installation_id)


@router.patch("/{installation_id}", response_model=InstallationRead)
async def rename_installation(
    installation_id: uuid.UUID,
    data: InstallationRename,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Rename one of your devices. A signed-out device cannot be renamed."""
    result, invalidations = await CompanionService(db).rename_installation(
        user.id, installation_id, data
    )
    background.add_task(publish_invalidations, invalidations)
    return result


@router.post("/{installation_id}/rotate", response_model=InstallationEnrollment)
async def rotate_device_token(
    installation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Mint a new device token; the previous one stops working immediately."""
    return await CompanionService(db).rotate_token(user.id, installation_id)


@router.delete("/{installation_id}", response_model=InstallationRead)
async def revoke_installation(
    installation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).revoke(user.id, installation_id)


@router.delete("/{installation_id}/sessions", response_model=SessionDeletionResult)
async def delete_installation_sessions(
    installation_id: uuid.UUID,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Delete every session this device captured; queued retries of them are
    dropped for 30 days."""
    result, invalidations = await CompanionService(db).delete_sessions(
        user.id, installation_id
    )
    background.add_task(publish_invalidations, invalidations)
    return result


@router.get("/{installation_id}/policy", response_model=CapturePolicy)
async def get_capture_policy(
    installation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).get_policy(user.id, installation_id)


@router.patch("/{installation_id}/policy", response_model=CapturePolicy)
async def update_capture_policy(
    installation_id: uuid.UUID,
    data: CapturePolicyUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).update_policy(user.id, installation_id, data)


@router.get("/{installation_id}/mappings", response_model=list[MappingRead])
async def list_mappings(
    installation_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).list_mappings(user.id, installation_id)


@router.post(
    "/{installation_id}/mappings",
    response_model=MappingRead,
    status_code=201,
    responses={200: {"model": MappingRead}},
)
async def create_mapping(
    installation_id: uuid.UUID,
    data: MappingCreate,
    response: Response,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Route a local project root into a workspace you belong to (and
    optionally one of its boards). Repeating an identical mapping returns 200."""
    mapping, created = await CompanionService(db).create_mapping(
        user.id, installation_id, data
    )
    if not created:
        response.status_code = 200
    return mapping


@router.patch("/{installation_id}/mappings/{mapping_id}", response_model=MappingRead)
async def update_mapping(
    installation_id: uuid.UUID,
    mapping_id: uuid.UUID,
    data: MappingUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await CompanionService(db).update_mapping(
        user.id, installation_id, mapping_id, data
    )


@router.delete("/{installation_id}/mappings/{mapping_id}", status_code=204)
async def delete_mapping(
    installation_id: uuid.UUID,
    mapping_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    await CompanionService(db).delete_mapping(user.id, installation_id, mapping_id)
    return Response(status_code=204)


# --- device -------------------------------------------------------------------


@device_router.get("/policy", response_model=DevicePolicy)
async def device_policy(
    capabilities: str | None = Header(None, alias=CAPABILITIES_HEADER, max_length=512),
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Capture policy, this installation's mappings, and the repositories bound
    to boards in the owner's workspaces (for local repo auto-matching).

    The device announces what it captures in `Backplane-Capture-Capabilities`
    on every read; `rich_capture` is the offer for `rich_capture_v1`, null
    when there is none."""
    return await CompanionService(db).device_policy(installation, capabilities)


@device_router.delete("/installation", response_model=InstallationRead)
async def revoke_own_installation(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Disconnect: the device revokes its own installation and token."""
    return await CompanionService(db).revoke_device(installation)


@device_router.post("/agent-key", response_model=AgentKeyCreated, status_code=201)
async def create_agent_key(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Mint the API key the device hands to the agents it launches, replacing
    any earlier one. `key` is returned only here, once. Limited to 10 an hour
    per device (429)."""
    return await CompanionService(db).create_agent_key(installation)


@device_router.get("/agent-key", response_model=AgentKeyRead)
async def get_agent_key(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """404 `agent_key_missing` when the device has none, e.g. because its owner
    deleted it on the web."""
    return await CompanionService(db).get_agent_key(installation)


@device_router.delete("/agent-key", status_code=204)
async def delete_agent_key(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    await CompanionService(db).delete_agent_key(installation)
    return Response(status_code=204)


@device_router.patch("/installation", response_model=InstallationRead)
async def rename_own_installation(
    data: InstallationRename,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """The device renames its own installation (the owner sees it by this name)."""
    result, invalidations = await CompanionService(db).rename_device(installation, data)
    background.add_task(publish_invalidations, invalidations)
    return result


@device_router.post("/status", response_model=HeartbeatResult)
async def report_status(
    data: DeviceStatusReport,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Heartbeat. Marks the device seen and stores its report at most once a
    minute (`recorded` is false for faster reports). Absolute paths in agent
    details are replaced by `[path]`."""
    result, invalidations = await CompanionService(db).record_status(installation, data)
    background.add_task(publish_invalidations, invalidations)
    return result


@device_router.post(
    "/mappings",
    response_model=MappingRead,
    status_code=201,
    responses={200: {"model": MappingRead}},
)
async def create_device_mapping(
    data: DeviceMappingRequest,
    response: Response,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """`{repo_url}` alone auto-matches: it maps the repository to the board the
    owner can access that uses it (404 when none, 409 `ambiguous_repo` when
    several workspaces do, 403 `auto_match_disabled`).

    Naming `workspace_id` and `board_id` binds a `root_path` and/or `repo_url`
    to that board instead: 403 when the owner is not a member of the
    workspace, 404 when the board is not in it.

    Either way, repeating a request for the same target returns the existing
    mapping with 200."""
    service = CompanionService(db)
    if isinstance(data, AutoMappingRequest):
        mapping, created = await service.auto_map(installation, data)
    else:
        mapping, created, invalidations = await service.device_create_mapping(
            installation, data
        )
        background.add_task(publish_invalidations, invalidations)
    if not created:
        response.status_code = 200
    return mapping


@device_router.get("/me", response_model=DeviceIdentity)
async def device_identity(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Who this device captures for, and which installation it is."""
    return await CompanionService(db).device_identity(installation)


@device_router.get("/boards", response_model=DeviceBoardList)
async def list_reachable_boards(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Workspaces the owner belongs to now, their boards, and the repositories
    bound to each board (`host/owner/repo`)."""
    return await CompanionService(db).device_boards(installation)


@device_router.get("/mappings", response_model=list[MappingRead])
async def list_device_mappings(
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """This installation's mappings into workspaces the owner still belongs to."""
    return await CompanionService(db).device_mappings(installation)


@device_router.patch("/mappings/{mapping_id}", response_model=MappingRead)
async def update_device_mapping(
    mapping_id: uuid.UUID,
    data: DeviceMappingUpdate,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """404 for another installation's mapping; 403 once the owner has left
    the mapping's workspace."""
    mapping, invalidations = await CompanionService(db).device_update_mapping(
        installation, mapping_id, data
    )
    background.add_task(publish_invalidations, invalidations)
    return mapping


@device_router.delete("/mappings/{mapping_id}", status_code=204)
async def delete_device_mapping(
    mapping_id: uuid.UUID,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    invalidations = await CompanionService(db).device_delete_mapping(
        installation, mapping_id
    )
    background.add_task(publish_invalidations, invalidations)
    return Response(status_code=204, background=background)


@device_router.patch("/settings", response_model=CapturePolicy)
async def update_device_settings(
    data: DeviceSettingsUpdate,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Retention is changed on the web only."""
    policy, invalidations = await CompanionService(db).device_update_settings(
        installation, data
    )
    background.add_task(publish_invalidations, invalidations)
    return policy


@device_router.get("/sessions", response_model=AgentSessionPage)
async def list_device_sessions(
    status: SessionStatus | None = None,
    cursor: str | None = Query(None, max_length=200),
    limit: int = Query(50, ge=1, le=100),
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Sessions this device uploaded, most recently active first, in the
    workspaces its owner still belongs to. Pass `next_cursor` back as `cursor`."""
    return await AgentSessionService(db).list_device_sessions(
        installation, status=status, cursor=cursor, limit=limit
    )


@device_router.get("/sessions/{session_id}", response_model=AgentSessionRead)
async def get_device_session(
    session_id: uuid.UUID,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await AgentSessionService(db).get_device_session(installation, session_id)


@device_router.get("/sessions/{session_id}/usage", response_model=SessionUsageList)
async def get_device_session_usage(
    session_id: uuid.UUID,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    return await AgentSessionService(db).device_session_usage(installation, session_id)


async def _bounded_body(request: Request) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_INGEST_BATCH_BYTES:
            raise PayloadTooLargeError()
        body.extend(chunk)
    return bytes(body)


@device_router.post(
    "/ingest",
    response_model=RichIngestResult,
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "At most 32 records and 8 MiB per batch, 4 MiB per "
            "record, 256 events per record and 64 KiB per event.",
            "content": {
                "application/json": {
                    "schema": ingest_request_schema(RichIngestBatchSchema)
                }
            },
        }
    },
)
async def ingest(
    request: Request,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Store capture records. Each record is acknowledged or rejected on its
    own; acknowledged records are durable once this response is sent. Replaying
    a capture_id with identical content is acknowledged again, with different
    content it is rejected as `conflict`.

    `contents` answers every content declaration of each acknowledged record
    (again on a replay); a rejected record gets none."""
    try:
        body = json.loads(await _bounded_body(request))
    except (ValueError, UnicodeDecodeError, RecursionError):
        raise ValidationError("Request body is not valid JSON") from None
    result, invalidations = await AgentSessionIngestService(db).ingest(
        installation, validate_batch_shape(body)
    )
    background.add_task(publish_invalidations, invalidations)
    return result


# --- rich capture: content uploads ------------------------------------------


async def _chunk_body(request: Request) -> bytes:
    """The chunk's bytes, refused before buffering past CHUNK_BYTES."""
    too_large = PayloadTooLargeError(
        "A chunk holds at most chunk_bytes",
        error_code="chunk_too_large",
        error_params={"chunk_bytes": CHUNK_BYTES},
    )
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > CHUNK_BYTES:
        raise too_large
    body = bytearray()
    async for piece in request.stream():
        if len(body) + len(piece) > CHUNK_BYTES:
            raise too_large
        body.extend(piece)
    return bytes(body)


def _upload_answer(answer: ContentUploadState | UploadRefusal):
    if isinstance(answer, UploadRefusal):
        return JSONResponse(
            status_code=answer.status_code,
            content=ContentError(
                detail=answer.detail,
                error_code=answer.error_code,
                error_params=answer.error_params,
            ).model_dump(mode="json"),
        )
    return answer


@device_router.put(
    "/contents/{content_id}/chunks/{index}",
    response_model=ChunkReceipt,
    openapi_extra={
        "requestBody": {
            "required": True,
            "description": "The chunk's raw bytes: chunk_bytes long except the "
            "last, which is the rest of the body.",
            "content": {"application/octet-stream": {"schema": {"type": "string"}}},
        }
    },
)
async def put_content_chunk(
    content_id: uuid.UUID,
    index: int,
    request: Request,
    chunk_sha256: str = Header(alias=CHUNK_DIGEST_HEADER, pattern=r"^[0-9a-f]{64}$"),
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Upload one chunk of a body the ingest answered `upload_required`. The
    same chunk again is acknowledged again; other bytes for it are a
    `chunk_conflict`. 404 for another installation's content, 410 once the
    upload expired, 409 `rich_capture_unavailable` while rich capture is off,
    503 `storage_backend_unavailable` to retry later."""
    chunk = await _chunk_body(request)
    return await SessionContentUploadService(db).put_chunk(
        installation, content_id, index, chunk, chunk_sha256
    )


@device_router.post(
    "/contents/{content_id}/finalize",
    response_model=ContentUploadState,
    responses={
        409: {"model": ContentError},
        422: {"model": ContentError, "description": "Unprocessable Content"},
    },
)
async def finalize_content(
    content_id: uuid.UUID,
    data: FinalizeRequest,
    background: BackgroundTasks,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Compose the chunks and publish the body once it matches its
    declaration. Answers the settled state: `available`, or `recorded` with
    the coverage the server applied. 409 `upload_incomplete` names missing
    chunks; 422 `body_checksum_mismatch` discards the chunks (after the third
    failure the upload is recorded as failed)."""
    service = SessionContentUploadService(db)
    finalized = await service.finalize(installation, content_id, data)
    # All run after the response, so only once the transaction committed.
    background.add_task(publish_invalidations, finalized.invalidations)
    background.add_task(service.delete_leftovers, finalized.leftovers)
    # Last, so nothing above waits on reading a body back; it opens its own
    # sessions, since this request's closes with the response.
    for indexed_id in finalized.index_content_ids:
        background.add_task(
            SessionSearchObjectProcessor(database.async_session).process_source,
            indexed_id,
        )
    return _upload_answer(finalized.answer)


@device_router.get("/contents/{content_id}", response_model=ContentUploadState)
async def get_content_upload(
    content_id: uuid.UUID,
    installation: CompanionInstallation = Depends(get_device_installation),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Where an upload stands, to resume it."""
    return await SessionContentUploadService(db).status(installation, content_id)
