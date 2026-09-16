# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""OIDC login / callback / logout endpoints.

  GET /api/auth/oidc/login     -> 302 to the IdP (PKCE challenge + state/nonce)
  GET /api/auth/oidc/callback  -> verify, provision, mint session, 302 to the UI
  GET /api/auth/oidc/logout    -> clear session, 302 to IdP logout or the UI

Every failure path redirects to the UI with an opaque `code=` — the browser
never sees an authorization code, an ID token, or an upstream error body.
The login leg's state, nonce and PKCE verifier ride in one signed cookie
(same itsdangerous pattern as the GitHub OAuth state cookie, distinct salt),
so the callback needs no server-side store of in-flight logins.
"""

from __future__ import annotations

import hmac
import secrets
from typing import Any

from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.core.oidc import OidcClient, OidcError
from app.core.session_cookie import SESSION_COOKIE_NAME, write_session
from app.database import get_db
from app.services.auth.oidc_auth import OidcAuthService, new_pkce_verifier

router = APIRouter(prefix="/api/auth/oidc", tags=["auth"])
# Sibling router: /modes describes auth as a whole, not the OIDC tier alone.
modes_router = APIRouter(prefix="/api/auth", tags=["auth"])

OIDC_STATE_COOKIE_NAME = "backplane_oidc_state"
OIDC_STATE_SALT = "oidc-login-state"
OIDC_STATE_MAX_AGE_SECONDS = 600


def get_oidc_client() -> OidcClient:
    # Tests override this dependency to inject a MockTransport-backed client.
    return OidcClient(
        issuer=settings.OIDC_ISSUER,
        client_id=settings.OIDC_CLIENT_ID,
        client_secret=settings.OIDC_CLIENT_SECRET,
    )


def oidc_is_configured() -> bool:
    return bool(
        settings.OIDC_ISSUER
        and settings.OIDC_CLIENT_ID
        and settings.OAUTH_STATE_SIGNING_KEY
    )


def password_is_enabled() -> bool:
    # True even with zero password users — a fresh instance right after
    # first-run setup must still render a login form. The signing key is
    # required because without it no login could ever mint a session cookie.
    return bool(settings.LOCAL_AUTH_ENABLED and settings.OAUTH_STATE_SIGNING_KEY)


@modes_router.get("/modes")
async def auth_modes() -> dict[str, object]:
    """Which login affordances the SPA should render. Deliberately UNAUTHENTICATED:
    a signed-out browser has to be able to discover that a login exists.

    Booleans and fixed paths only — the issuer, client id and IdP hostname stay
    server-side so an anonymous caller learns nothing about the deployment.
    """
    return {
        "oidc_enabled": oidc_is_configured(),
        "password_enabled": password_is_enabled(),
        "dev_mode": settings.is_development,
        "login_path": f"{router.prefix}/login",
        "logout_path": f"{router.prefix}/logout",
    }


@router.get("/login", response_class=RedirectResponse)
async def oidc_login(client: OidcClient = Depends(get_oidc_client)):
    if not oidc_is_configured():
        return _error_redirect("oidc_not_configured")

    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    verifier = new_pkce_verifier()

    try:
        url = await OidcAuthService(client).authorization_url(
            redirect_uri=_callback_redirect_uri(),
            state=state,
            nonce=nonce,
            code_verifier=verifier,
        )
    except OidcError:
        return _error_redirect("idp_unreachable")

    response = RedirectResponse(url=url, status_code=302)
    response.set_cookie(
        key=OIDC_STATE_COOKIE_NAME,
        value=_serialize_state({"state": state, "nonce": nonce, "verifier": verifier}),
        max_age=OIDC_STATE_MAX_AGE_SECONDS,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )
    return response


@router.get("/callback", response_class=RedirectResponse)
async def oidc_callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
    client: OidcClient = Depends(get_oidc_client),
):
    if error := request.query_params.get("error"):
        return _error_redirect(error)

    code = request.query_params.get("code")
    state_param = request.query_params.get("state")
    raw_cookie = request.cookies.get(OIDC_STATE_COOKIE_NAME)
    if not raw_cookie or not code or not state_param:
        return _error_redirect("missing_state_or_code")

    try:
        payload = _deserialize_state(raw_cookie)
    except OidcError:
        return _error_redirect("state_invalid_or_expired")

    # Constant-time: a timing oracle on state would weaken CSRF protection.
    if not hmac.compare_digest(str(payload.get("state", "")), state_param):
        return _error_redirect("state_mismatch")

    try:
        user = await OidcAuthService(client, db).complete_login(
            code=code,
            code_verifier=str(payload["verifier"]),
            redirect_uri=_callback_redirect_uri(),
            nonce=str(payload["nonce"]),
            path=request.url.path,
        )
    except OidcError as exc:
        return _error_redirect(exc.error_code)

    response = RedirectResponse(url=settings.FRONTEND_URL.rstrip("/"), status_code=302)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=write_session(user.id, signing_key=settings.OAUTH_STATE_SIGNING_KEY),
        max_age=settings.OIDC_SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )
    # One-shot: the login leg's state must not be replayable.
    response.delete_cookie(OIDC_STATE_COOKIE_NAME, path="/")
    return response


@router.get("/logout", response_class=RedirectResponse)
async def oidc_logout(client: OidcClient = Depends(get_oidc_client)):
    frontend = settings.FRONTEND_URL.rstrip("/")
    target = frontend
    if oidc_is_configured():
        try:
            end_session = await OidcAuthService(client).end_session_url(
                post_logout_redirect_uri=frontend
            )
            target = end_session or frontend
        except OidcError:
            # Signing out locally must work even when the IdP is unreachable.
            target = frontend

    response = RedirectResponse(url=target, status_code=302)
    response.delete_cookie(SESSION_COOKIE_NAME, path="/")
    return response


def _serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(
        settings.OAUTH_STATE_SIGNING_KEY, salt=OIDC_STATE_SALT
    )


def _serialize_state(payload: dict[str, str]) -> str:
    return _serializer().dumps(payload)


def _deserialize_state(raw: str) -> dict[str, Any]:
    try:
        data = _serializer().loads(raw, max_age=OIDC_STATE_MAX_AGE_SECONDS)
    except (BadSignature, SignatureExpired) as exc:
        raise OidcError("Login state is invalid or expired") from exc
    if not isinstance(data, dict) or not {"state", "nonce", "verifier"} <= data.keys():
        raise OidcError("Login state payload is malformed")
    return data


def _callback_redirect_uri() -> str:
    return f"{settings.API_URL.rstrip('/')}/api/auth/oidc/callback"


def _error_redirect(error_code: str) -> RedirectResponse:
    safe = "".join(c for c in error_code if c.isalnum() or c in "_-")[:64]
    return RedirectResponse(
        url=f"{settings.FRONTEND_URL.rstrip('/')}/login?code={safe}", status_code=302
    )
