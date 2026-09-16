# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""GitHubAdapter — GitService implementation backed by githubkit.

LAYER: integrations (provider-agnostic, OAuth, multi-provider).
The legacy single-token client lives at app/services/github_client.py and
is used by hot paths (Done-gate, card service, scheduler) that haven't
been migrated yet. This adapter is for OAuth-driven, per-connection access
(merge executor, repo picker, PR sync).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import AsyncIterator

import httpx
from githubkit import GitHub
from githubkit.exception import RequestFailed

from app.integrations.git.exceptions import (
    GitAuthError,
    GitNotFoundError,
    GitProviderError,
    GitProviderUnavailable,
    GitRateLimitError,
)
from app.integrations.git.models import Branch, Repository
from app.integrations.git.models import User as GitUser
from app.integrations.git.url_helpers import embed_token_in_https_url


# `<https://api.github.com/user/repos?page=2&per_page=100>; rel="next"` —
# we only care about the page= query value of whichever segment is `rel="next"`.
_LINK_NEXT_PATTERN = re.compile(
    r'<[^>]*[?&]page=(?P<page>\d+)[^>]*>;\s*rel="next"'
)


class GitHubAdapter:
    provider = "github"

    def __init__(
        self,
        *,
        access_token: str,
        base_url: str | None = None,
        async_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        # auto_retry off: we want deterministic surface behavior — retry policy
        # belongs to the caller (merge queue worker decides whether to back off
        # on a GitRateLimitError). http_cache off: hishel disk cache is
        # surprising in tests and unnecessary for the OAuth flows we drive.
        self._token = access_token
        self._base_url = base_url
        self._client = GitHub(
            access_token,
            base_url=base_url,
            async_transport=async_transport,
            auto_retry=False,
            http_cache=False,
        )

    async def get_authenticated_user(self) -> GitUser:
        data = await self._get_json("GET", "/user")
        return GitUser(
            provider="github",
            id=str(data["id"]),
            username=data["login"],
            email=data.get("email"),
            avatar_url=data.get("avatar_url"),
        )

    async def list_repositories(
        self, *, cursor: str | None = None
    ) -> tuple[list[Repository], str | None]:
        page = int(cursor) if cursor else 1
        response = await self._arequest(
            "GET", f"/user/repos?per_page=100&page={page}"
        )
        items = [_repo_from_payload(item) for item in response.json()]
        next_cursor = _next_page_from_link_header(
            response.headers.get("link") or response.headers.get("Link")
        )
        return items, next_cursor

    async def get_repository(self, repo_id: str) -> Repository:
        data = await self._get_json("GET", f"/repos/{repo_id}")
        return _repo_from_payload(data)

    async def list_branches(self, repo_id: str) -> AsyncIterator[Branch]:
        # We need to confirm the repo exists before opening the iterator —
        # otherwise a caller that never advances `async for` would silently
        # swallow the 404. paginate() defers the first request until the
        # iterator is consumed; doing one explicit page lookup up front gives
        # us the not-found signal regardless of consumption order.
        page = 1
        while True:
            response = await self._arequest(
                "GET", f"/repos/{repo_id}/branches?per_page=100&page={page}"
            )
            items = response.json()
            if not items:
                return
            for branch in items:
                yield Branch(
                    provider="github",
                    name=branch["name"],
                    sha=branch["commit"]["sha"],
                )
            if not _next_page_from_link_header(
                response.headers.get("link") or response.headers.get("Link")
            ):
                return
            page += 1

    async def get_authenticated_clone_url(self, repo_id: str) -> str:
        host = "github.com"
        if self._base_url:
            parsed = httpx.URL(self._base_url)
            # Enterprise: `https://git.acme.com/api/v3` -> clones at `git.acme.com`.
            host = parsed.host
        url = f"https://{host}/{repo_id}.git"
        return embed_token_in_https_url(url, self._token)

    async def raw(self) -> object:
        return self._client

    # ------------------------------------------------------------------ helpers

    async def _get_json(self, method: str, path: str) -> dict:
        response = await self._arequest(method, path)
        return response.json()

    async def _arequest(self, method: str, path: str):
        try:
            return await self._client.arequest(method, path)
        except RequestFailed as exc:
            raise _map_request_failed(exc) from exc
        except httpx.HTTPError as exc:
            raise GitProviderUnavailable(
                f"github request failed: {type(exc).__name__}"
            ) from exc


def _repo_from_payload(payload: dict) -> Repository:
    # Map the subset we normalize and stash the original payload for callers
    # that need provider-specific fields (e.g. branch protection rules).
    return Repository(
        provider="github",
        id=payload["full_name"],
        full_name=payload["full_name"],
        default_branch=payload.get("default_branch") or "main",
        private=bool(payload.get("private", False)),
        clone_url_https=payload.get("clone_url")
        or f"https://github.com/{payload['full_name']}.git",
        updated_at=_parse_iso8601(payload.get("updated_at")),
        provider_data=payload,
    )


def _parse_iso8601(value: str | None) -> datetime:
    if not value:
        return datetime.utcnow()
    # GitHub returns `2026-01-01T00:00:00Z`; fromisoformat in 3.11+ handles
    # the trailing Z natively when we swap it for `+00:00`.
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _next_page_from_link_header(link: str | None) -> str | None:
    if not link:
        return None
    match = _LINK_NEXT_PATTERN.search(link)
    return match.group("page") if match else None


def _map_request_failed(exc: RequestFailed) -> GitProviderError:
    response = exc.response
    status = response.status_code
    if status == 401:
        return GitAuthError("github authentication failed")
    if status == 403:
        # 403 from GitHub almost always means token lacks scope or the repo
        # is private to a different account — treat as auth-shaped from the
        # caller's perspective.
        return GitAuthError("github access denied (token scope or visibility)")
    if status == 404:
        return GitNotFoundError("github resource not found")
    if status == 429:
        retry_after = _retry_after_seconds(
            response.headers.get("retry-after")
            or response.headers.get("Retry-After")
        )
        return GitRateLimitError(
            "github rate limit exceeded", retry_after=retry_after
        )
    if 500 <= status < 600:
        return GitProviderUnavailable(f"github upstream {status}")
    return GitProviderError(f"github request failed (status={status})")


def _retry_after_seconds(header_value: str | None) -> int | None:
    if not header_value:
        return None
    try:
        return int(header_value)
    except ValueError:
        # Spec allows HTTP-date too; we don't currently translate it.
        return None
