# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GitHub OAuth web-flow router.

Two endpoints:
  GET /api/workspaces/{slug}/oauth/github/start    (admin) -> 302 to github.com
  GET /api/oauth/github/callback                          -> 302 back to UI

The callback runs WITHOUT a workspace dependency: by spec, it must work
for any signed-in user whose state cookie was issued by `start`. The
state cookie carries the workspace slug + user id signed by
`OAUTH_STATE_SIGNING_KEY`, so the callback re-resolves both before
upserting the connection.
"""

from __future__ import annotations

import hmac
import uuid
from app.utils import utcnow
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import config as _config
from app.core.workspace import WorkspaceContext, get_workspace_admin
from app.database import get_db
from app.integrations.git.oauth_github_client import (
    exchange_code_for_token,
    fetch_account,
)
from app.integrations.git.oauth_state import (
    OAUTH_STATE_COOKIE_NAME,
    OAUTH_STATE_MAX_AGE_SECONDS,
    OAuthStateConfigError,
    OAuthStateInvalid,
    OAuthStatePayload,
    deserialize_state,
    new_state_nonce,
    serialize_state,
)
from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.services.git.git_connection import GitConnectionService

router = APIRouter(tags=["integrations-oauth"])

GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_DEFAULT_SCOPES = "repo"


@router.get(
    "/api/workspaces/{slug}/oauth/github/start",
    status_code=302,
    response_class=RedirectResponse,
)
async def oauth_github_start(
    ctx: WorkspaceContext = Depends(get_workspace_admin),
):
    if (
        not _config.settings.GITHUB_OAUTH_CLIENT_ID
        or not _config.settings.OAUTH_STATE_SIGNING_KEY
    ):
        # Surface a recognizable error_code instead of redirecting to a
        # broken github.com URL. The frontend can show a "configure GitHub"
        # banner against this code.
        raise OAuthStateConfigError("GitHub OAuth is not configured")

    state_nonce = new_state_nonce()
    cookie_value = serialize_state(
        OAuthStatePayload(
            state=state_nonce,
            workspace_slug=ctx.workspace.slug,
            user_id=str(ctx.user.id),
        ),
        signing_key=_config.settings.OAUTH_STATE_SIGNING_KEY,
    )
    redirect_url = (
        GITHUB_AUTHORIZE_URL
        + "?"
        + urlencode(
            {
                "client_id": _config.settings.GITHUB_OAUTH_CLIENT_ID,
                "redirect_uri": _callback_redirect_uri(),
                "scope": GITHUB_DEFAULT_SCOPES,
                "state": state_nonce,
                "allow_signup": "false",
            }
        )
    )
    response = RedirectResponse(url=redirect_url, status_code=302)
    response.set_cookie(
        key=OAUTH_STATE_COOKIE_NAME,
        value=cookie_value,
        max_age=OAUTH_STATE_MAX_AGE_SECONDS,
        httponly=True,
        secure=_config.settings.session_cookie_secure,
        samesite="lax",
        path="/",
    )
    return response


async def _http_client_dependency() -> httpx.AsyncClient:
    return _build_http_client()


@router.get("/api/oauth/github/callback", response_class=RedirectResponse)
async def oauth_github_callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
    http_client: httpx.AsyncClient = Depends(_http_client_dependency),
):
    code = request.query_params.get("code")
    state_param = request.query_params.get("state")
    error_from_provider = request.query_params.get("error")
    if error_from_provider:
        return _error_redirect(error_from_provider)

    raw_cookie = request.cookies.get(OAUTH_STATE_COOKIE_NAME)
    if not raw_cookie or not code or not state_param:
        return _error_redirect("missing_state_or_code")

    try:
        payload = deserialize_state(
            raw_cookie, signing_key=_config.settings.OAUTH_STATE_SIGNING_KEY
        )
    except OAuthStateInvalid:
        return _error_redirect("state_invalid_or_expired")

    # Constant-time comparison defends against timing-side-channel state guesses.
    if not hmac.compare_digest(payload.state, state_param):
        return _error_redirect("state_mismatch")

    try:
        user_uuid = uuid.UUID(payload.user_id)
    except ValueError:
        return _error_redirect("workspace_or_user_missing")

    workspace = (
        await db.execute(
            select(Workspace).where(Workspace.slug == payload.workspace_slug)
        )
    ).scalar_one_or_none()
    user = (
        await db.execute(select(User).where(User.id == user_uuid))
    ).scalar_one_or_none()
    if workspace is None or user is None:
        return _error_redirect("workspace_or_user_missing")

    # The start endpoint required admin, but the OAuth dance takes wall-clock
    # time — re-verify the role at callback so a mid-flow demotion fails closed.
    membership = (
        await db.execute(
            select(WorkspaceMember).where(
                WorkspaceMember.workspace_id == workspace.id,
                WorkspaceMember.user_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if membership is None or membership.role not in (
        WorkspaceRole.owner,
        WorkspaceRole.admin,
    ):
        return _error_redirect("admin_role_revoked")

    try:
        async with http_client as client:
            token = await exchange_code_for_token(
                client,
                client_id=_config.settings.GITHUB_OAUTH_CLIENT_ID,
                client_secret=_config.settings.GITHUB_OAUTH_CLIENT_SECRET,
                code=code,
                redirect_uri=_callback_redirect_uri(),
            )
            account = await fetch_account(client, access_token=token.access_token)
    except OAuthStateConfigError:
        return _error_redirect("oauth_misconfigured")
    except Exception as exc:
        # Map to opaque error code — never echo the OAuth code, token, or
        # the upstream message (it may quote our request payload).
        return _error_redirect(getattr(exc, "error_code", "exchange_failed"))

    service = GitConnectionService(
        db, vault=FernetTokenVault(_config.settings.INTEGRATIONS_TOKEN_KEY.encode())
    )
    await service.create_or_update_connection(
        workspace_id=workspace.id,
        provider=GitProvider.github,
        account_login=account.login,
        account_type=account.account_type,
        access_token=token.access_token,
        refresh_token=token.refresh_token,
        scopes=token.scopes,
        connected_by=user.id,
        # The code-for-token exchange we just completed IS a successful probe:
        # the forge handed us this token and named the account it belongs to.
        # Naive UTC (house style) — tz-aware values die in asyncpg against the
        # timezone-less columns.
        last_verified_at=utcnow(),
    )

    response = RedirectResponse(
        url=_success_redirect_uri(payload.workspace_slug), status_code=302
    )
    response.delete_cookie(OAUTH_STATE_COOKIE_NAME, path="/")
    return response


def _build_http_client() -> httpx.AsyncClient:
    # Tests override the FastAPI dependency to inject a MockTransport.
    return httpx.AsyncClient(timeout=10.0)


def _callback_redirect_uri() -> str:
    return f"{_config.settings.API_URL.rstrip('/')}/api/oauth/github/callback"


def _success_redirect_uri(workspace_slug: str) -> str:
    return f"{_config.settings.FRONTEND_URL.rstrip('/')}/{workspace_slug}/settings#integrations"


def _error_redirect(error_code: str) -> RedirectResponse:
    safe = "".join(c for c in error_code if c.isalnum() or c in "_-")[:64]
    return RedirectResponse(
        url=f"{_config.settings.FRONTEND_URL.rstrip('/')}/oauth-error?code={safe}",
        status_code=302,
    )
