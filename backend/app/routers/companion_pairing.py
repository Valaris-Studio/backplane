# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from fastapi import APIRouter, BackgroundTasks, Depends
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.auth import forbid_credential_management, get_current_user
from app.core.companion_switch import require_companion_enabled
from app.core.private_route import PrivateRoute
from app.database import get_db
from app.exceptions import ValarisError
from app.models.user import User
from app.schemas.companion_pairing import (
    PairingCodeRequest,
    PairingGrant,
    PairingRequestRead,
    PairingStart,
    PairingStarted,
    PairingTokenErrorBody,
    PairingTokenRequest,
)
from app.services.companion_pairing import (
    CompanionPairingService,
    PairingCodeNotFound,
    PairingGrantRefused,
)
from app.services.session_events import publish_invalidations

device_router = APIRouter(
    prefix="/api/companion/pairing",
    tags=["companion-pairing"],
    route_class=PrivateRoute,
    dependencies=[Depends(require_companion_enabled)],
)
router = APIRouter(
    prefix="/api/me/companion/pairing",
    tags=["companion-pairing"],
    route_class=PrivateRoute,
    dependencies=[
        Depends(require_companion_enabled),
        Depends(forbid_credential_management),
    ],
)


def _committed_error(error: ValarisError) -> JSONResponse:
    # Returned, not raised: get_db rolls back on an exception, which would undo
    # the poll timestamp or failed attempt this refusal just recorded.
    return JSONResponse(
        status_code=error.status_code,
        content=jsonable_encoder(
            {
                "detail": error.detail,
                "error_code": error.error_code,
                "error_params": error.error_params,
                "context": error.context,
            }
        ),
    )


@device_router.post("", response_model=PairingStarted)
async def start_pairing(
    data: PairingStart, db: AsyncSession = Depends(get_db, scope="function")
):
    """Start browser-code pairing (RFC 8628 device authorization request). No
    credentials; rate-limited per client IP. Show `user_code` and open
    `verification_uri_complete`, then poll the token endpoint."""
    return await CompanionPairingService(db).start(data)


@device_router.post(
    "/token",
    response_model=PairingGrant,
    responses={400: {"model": PairingTokenErrorBody}},
)
async def collect_pairing_token(
    data: PairingTokenRequest,
    background: BackgroundTasks,
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Poll for the device token. 400 `authorization_pending` until approved,
    `slow_down` when polled faster than `interval`, `access_denied` once denied,
    `expired_token` once expired or after the token was delivered: the 200
    carrying it is sent exactly once."""
    try:
        grant, invalidations = await CompanionPairingService(db).collect(
            data.device_code
        )
    except PairingGrantRefused as refusal:
        return _committed_error(refusal)
    background.add_task(publish_invalidations, invalidations)
    return grant


@router.post("/lookup", response_model=PairingRequestRead)
async def get_pairing_request(
    data: PairingCodeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """The device asking to connect, for the approval page. 404 for an unknown
    code or one another person approved; 429 after 5 misses in 10 minutes."""
    try:
        return await CompanionPairingService(db).lookup(user.id, data.user_code)
    except PairingCodeNotFound as missing:
        return _committed_error(missing)


@router.post("/approve", response_model=PairingRequestRead)
async def approve_pairing(
    data: PairingCodeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    """Approve the device. Its next poll creates the installation, owned by
    you, and collects its token. Repeating the approval is a no-op."""
    try:
        return await CompanionPairingService(db).approve(user.id, data.user_code)
    except PairingCodeNotFound as missing:
        return _committed_error(missing)


@router.post("/deny", response_model=PairingRequestRead)
async def deny_pairing(
    data: PairingCodeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db, scope="function"),
):
    try:
        return await CompanionPairingService(db).deny(user.id, data.user_code)
    except PairingCodeNotFound as missing:
        return _committed_error(missing)
