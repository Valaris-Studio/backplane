# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP shims for the GitHub OAuth web flow.

LAYER: integrations. Two side-effects:
  1. POST github.com/login/oauth/access_token to swap the auth code.
  2. GET api.github.com/user once we have the token, so we know which
     account we just connected.

Both calls go through a single `httpx.AsyncClient` that the OAuth router
constructs once per request. Tests substitute a fake transport via
`make_oauth_http_client_dep` so the router stays free of network mocks.
"""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from app.integrations.git.exceptions import (
    GitAuthError,
    GitProviderError,
    GitProviderUnavailable,
)


GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_API_USER_URL = "https://api.github.com/user"


@dataclass(frozen=True)
class GitHubTokenExchange:
    access_token: str
    scopes: list[str]
    refresh_token: str | None
    token_type: str


@dataclass(frozen=True)
class GitHubAccount:
    login: str
    account_type: str  # "user" or "organization"


async def exchange_code_for_token(
    http_client: httpx.AsyncClient,
    *,
    client_id: str,
    client_secret: str,
    code: str,
    redirect_uri: str,
) -> GitHubTokenExchange:
    # Accept: application/json forces a JSON response — the default is
    # urlencoded which we'd need a second parser for.
    response = await http_client.post(
        GITHUB_OAUTH_TOKEN_URL,
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": redirect_uri,
        },
        headers={"Accept": "application/json"},
    )
    if response.status_code >= 500:
        raise GitProviderUnavailable("github token endpoint upstream error")
    if response.status_code != 200:
        raise GitProviderError(
            f"github token endpoint returned status {response.status_code}"
        )
    body = response.json()
    if "error" in body:
        # GitHub returns 200 with `{"error": "bad_verification_code", ...}`
        # on bad codes — never log `body` here, the request payload is in it.
        raise GitAuthError(f"github oauth error: {body['error']}")
    access_token = body.get("access_token")
    if not access_token:
        raise GitAuthError("github did not return an access_token")
    return GitHubTokenExchange(
        access_token=access_token,
        scopes=[s for s in body.get("scope", "").split(",") if s],
        refresh_token=body.get("refresh_token"),
        token_type=body.get("token_type", "bearer"),
    )


async def fetch_account(
    http_client: httpx.AsyncClient, *, access_token: str
) -> GitHubAccount:
    response = await http_client.get(
        GITHUB_API_USER_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/vnd.github+json",
        },
    )
    if response.status_code == 401:
        raise GitAuthError("github /user returned 401 with the freshly issued token")
    if response.status_code >= 500:
        raise GitProviderUnavailable("github /user upstream error")
    if response.status_code != 200:
        raise GitProviderError(
            f"github /user returned status {response.status_code}"
        )
    body = response.json()
    raw_type = (body.get("type") or "User").lower()
    # GitHub sends "User" / "Organization"; our DB CHECK is "user" / "organization".
    account_type = "organization" if raw_type == "organization" else "user"
    return GitHubAccount(login=body["login"], account_type=account_type)
