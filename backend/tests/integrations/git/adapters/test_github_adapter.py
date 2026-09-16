# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Adapter-specific unit tests for GitHubAdapter.

Behavioral parity with the GitService contract is covered by
tests/integrations/git/test_contract.py — those 10 tests run against this
adapter via the [github] parametrize id. The cases here cover surface area
the contract suite intentionally leaves provider-agnostic: error mapping
detail (status -> exception subclass + payload), Link-header pagination,
and the clone-URL token-embedding shape.
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.integrations.git.adapters.github import GitHubAdapter
from app.integrations.git.exceptions import (
    GitAuthError,
    GitNotFoundError,
    GitProviderError,
    GitProviderUnavailable,
    GitRateLimitError,
)


def _build_adapter(handler, *, token: str = "fixture-token") -> GitHubAdapter:
    transport = httpx.MockTransport(handler)
    return GitHubAdapter(access_token=token, async_transport=transport)


def _json_response(status: int, body, headers: dict[str, str] | None = None) -> httpx.Response:
    return httpx.Response(
        status,
        content=json.dumps(body).encode(),
        headers={"content-type": "application/json", **(headers or {})},
    )


@pytest.mark.asyncio
async def test_get_authenticated_user_maps_401_to_git_auth_error():
    def handler(request):
        return _json_response(401, {"message": "Bad credentials"})

    adapter = _build_adapter(handler)
    with pytest.raises(GitAuthError):
        await adapter.get_authenticated_user()


@pytest.mark.asyncio
async def test_get_repository_maps_404_to_git_not_found_error():
    def handler(request):
        return _json_response(404, {"message": "Not Found"})

    adapter = _build_adapter(handler)
    with pytest.raises(GitNotFoundError):
        await adapter.get_repository("ghost/repo")


@pytest.mark.asyncio
async def test_get_authenticated_user_maps_429_to_git_rate_limit_error_with_retry_after():
    def handler(request):
        return _json_response(
            429,
            {"message": "rate limited"},
            headers={"Retry-After": "42"},
        )

    adapter = _build_adapter(handler)
    with pytest.raises(GitRateLimitError) as excinfo:
        await adapter.get_authenticated_user()
    assert excinfo.value.retry_after == 42


@pytest.mark.asyncio
async def test_get_authenticated_user_maps_500_to_git_provider_unavailable():
    def handler(request):
        return _json_response(500, {"message": "boom"})

    adapter = _build_adapter(handler)
    with pytest.raises(GitProviderUnavailable):
        await adapter.get_authenticated_user()


@pytest.mark.asyncio
async def test_unhandled_status_maps_to_generic_git_provider_error():
    def handler(request):
        return _json_response(418, {"message": "teapot"})

    adapter = _build_adapter(handler)
    with pytest.raises(GitProviderError):
        await adapter.get_authenticated_user()


@pytest.mark.asyncio
async def test_get_authenticated_clone_url_embeds_x_access_token():
    def handler(request):
        return _json_response(200, {})

    adapter = _build_adapter(handler, token="ghp_secrettoken123")
    url = await adapter.get_authenticated_clone_url("acme/widgets")
    assert url == "https://x-access-token:ghp_secrettoken123@github.com/acme/widgets.git"


@pytest.mark.asyncio
async def test_get_authenticated_clone_url_uses_enterprise_host_when_base_url_set():
    transport = httpx.MockTransport(lambda r: _json_response(200, {}))
    adapter = GitHubAdapter(
        access_token="t",
        base_url="https://git.acme.com/api/v3",
        async_transport=transport,
    )
    url = await adapter.get_authenticated_clone_url("team/svc")
    assert url == "https://x-access-token:t@git.acme.com/team/svc.git"


@pytest.mark.asyncio
async def test_list_repositories_parses_next_cursor_from_link_header():
    def handler(request):
        return _json_response(
            200,
            [],
            headers={
                "Link": (
                    '<https://api.github.com/user/repos?page=3&per_page=100>; rel="next", '
                    '<https://api.github.com/user/repos?page=12&per_page=100>; rel="last"'
                )
            },
        )

    adapter = _build_adapter(handler)
    _items, cursor = await adapter.list_repositories()
    assert cursor == "3"


@pytest.mark.asyncio
async def test_list_repositories_returns_none_cursor_when_no_next_link():
    def handler(request):
        return _json_response(
            200,
            [],
            headers={
                "Link": '<https://api.github.com/user/repos?page=1&per_page=100>; rel="prev"'
            },
        )

    adapter = _build_adapter(handler)
    _items, cursor = await adapter.list_repositories()
    assert cursor is None


@pytest.mark.asyncio
async def test_list_repositories_advances_with_cursor():
    received_pages: list[str | None] = []

    def handler(request):
        received_pages.append(request.url.params.get("page"))
        return _json_response(200, [])

    adapter = _build_adapter(handler)
    await adapter.list_repositories(cursor="7")
    assert received_pages == ["7"]


@pytest.mark.asyncio
async def test_get_authenticated_user_maps_403_to_git_auth_error():
    def handler(request):
        return _json_response(403, {"message": "Forbidden"})

    adapter = _build_adapter(handler)
    with pytest.raises(GitAuthError):
        await adapter.get_authenticated_user()
