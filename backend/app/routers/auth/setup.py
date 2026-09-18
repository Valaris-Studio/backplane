# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""First-run setup: mint the first admin account on an empty instance (L2).

  GET  /api/auth/setup-status -> {"needs_setup": bool}
  POST /api/auth/setup        -> create first user, mint session, 201

Both are unauthenticated by design — a signed-out browser on a fresh
deployment has to be able to discover and complete setup. POST self-closes
the instant any user exists.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.auth import resolve_client_ip
from app.core.session_cookie import SESSION_COOKIE_NAME, write_session
from app.database import get_db
from app.schemas.auth import FirstRunSetupRequest
from app.schemas.user import UserRead
from app.services.auth.local_auth import LocalAuthService

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.get("/setup-status")
async def setup_status(db: AsyncSession = Depends(get_db, scope="function")) -> dict[str, bool]:
    return {"needs_setup": await LocalAuthService(db).needs_setup()}


@router.post("/setup", response_model=UserRead, status_code=201)
async def first_run_setup(
    body: FirstRunSetupRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db, scope="function"),
) -> UserRead:
    user = await LocalAuthService(db).create_first_admin(
        body.email,
        body.password,
        path=request.url.path,
        client_ip=resolve_client_ip(request),
    )
    if user is None:
        # Mirrors FastAPI's unknown-route body: a configured instance should
        # not even confirm that a setup surface exists.
        raise HTTPException(status_code=404, detail="Not Found")
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
