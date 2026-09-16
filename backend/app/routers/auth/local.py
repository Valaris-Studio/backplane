# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Local email+password login and logout.

  POST /api/auth/login  -> verify credentials, mint the signed session cookie
  POST /api/auth/logout -> clear the cookie (idempotent)

Every rejection funnels through one raise site, so unknown email, missing
local credential, and wrong password are byte-identical on the wire — the
service already makes them indistinguishable in timing.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import get_current_user, resolve_client_ip
from app.core.session_cookie import SESSION_COOKIE_NAME, write_session
from app.database import get_db
from app.exceptions import InvalidCredentialsError
from app.models.user import User
from app.schemas.auth import ChangePasswordRequest, LocalLoginRequest
from app.schemas.user import UserRead
from app.services.auth.local_auth import LocalAuthService

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=UserRead)
async def local_login(
    body: LocalLoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    if not settings.LOCAL_AUTH_ENABLED:
        # The surface is off: answer like the route never existed.
        raise HTTPException(status_code=404, detail="Not Found")
    user = await LocalAuthService(db).authenticate(
        body.email,
        body.password,
        path=request.url.path,
        client_ip=resolve_client_ip(request),
    )
    if user is None:
        raise InvalidCredentialsError()
    # Session fixation: every login signs a fresh timestamped cookie value.
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=write_session(user.id, signing_key=settings.OAUTH_STATE_SIGNING_KEY),
        max_age=settings.OIDC_SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )
    return user


@router.post("/change-password", status_code=204, response_class=Response)
async def change_password(
    body: ChangePasswordRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    if not settings.LOCAL_AUTH_ENABLED:
        raise HTTPException(status_code=404, detail="Not Found")
    # No cookie re-issue: the session is a stateless signed user-id + TTL and
    # carries no password-derived state, so there is nothing to rotate. (The
    # flip side — other sessions stay valid after a change — is documented in
    # SECURITY.md by card 9.)
    await LocalAuthService(db).change_password(
        user,
        body.current_password,
        body.new_password,
        path=request.url.path,
        client_ip=resolve_client_ip(request),
    )


@router.post("/logout", status_code=204, response_class=Response)
async def local_logout(response: Response):
    # No enabled-check and no session requirement: clearing a cookie that is
    # already gone must succeed, and logout must outlive config changes.
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
