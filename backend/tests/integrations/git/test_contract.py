# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Provider-agnostic contract suite for the GitService Protocol.

Per docs/research/git-multiprovider-spec.md §10: every adapter must pass
this same suite. If GitHub passes and GitLab fails, either GitLab has a
bug or the contract itself is wrong — both findings are valuable.

The `git_service_factory` fixture (see conftest.py) parametrizes every
test in this file across every registered implementation.
"""

from __future__ import annotations

from datetime import datetime

import pytest

from app.integrations.git.exceptions import GitAuthError, GitNotFoundError
from app.integrations.git.models import Branch, Repository, User as GitUser


@pytest.mark.asyncio
async def test_get_authenticated_user_returns_user_with_provider_field(
    git_service_factory,
):
    service = git_service_factory()
    user = await service.get_authenticated_user()

    assert isinstance(user, GitUser)
    assert user.provider
    assert user.id
    assert user.username


@pytest.mark.asyncio
async def test_get_authenticated_user_raises_git_auth_error_on_invalid_creds(
    git_service_factory,
):
    service = git_service_factory(auth_error=True)
    with pytest.raises(GitAuthError):
        await service.get_authenticated_user()


@pytest.mark.asyncio
async def test_list_repositories_returns_tuple_of_list_and_optional_cursor(
    git_service_factory,
):
    service = git_service_factory()
    result = await service.list_repositories()

    assert isinstance(result, tuple)
    assert len(result) == 2
    items, cursor = result
    assert isinstance(items, list)
    assert cursor is None or isinstance(cursor, str)


@pytest.mark.asyncio
async def test_list_repositories_items_are_repository_pydantic_models(
    git_service_factory,
):
    service = git_service_factory()
    items, _ = await service.list_repositories()

    assert items, "fixture must include at least one repository"
    for repo in items:
        assert isinstance(repo, Repository)
        assert repo.provider
        assert repo.id
        assert repo.full_name
        assert repo.default_branch
        assert isinstance(repo.private, bool)
        assert repo.clone_url_https.startswith(("http://", "https://"))
        assert isinstance(repo.updated_at, datetime)


@pytest.mark.asyncio
async def test_get_repository_returns_matching_id(git_service_factory):
    service = git_service_factory()
    items, _ = await service.list_repositories()
    target = items[0]

    fetched = await service.get_repository(target.id)

    assert isinstance(fetched, Repository)
    assert fetched.id == target.id
    assert fetched.full_name == target.full_name


@pytest.mark.asyncio
async def test_get_repository_raises_git_not_found_error_for_unknown_id(
    git_service_factory,
):
    unknown_id = "ghost-org/ghost-repo"
    service = git_service_factory(not_found_repo_ids={unknown_id})

    with pytest.raises(GitNotFoundError):
        await service.get_repository(unknown_id)


@pytest.mark.asyncio
async def test_list_branches_yields_branch_models(git_service_factory):
    service = git_service_factory()
    items, _ = await service.list_repositories()
    repo_id = items[0].id

    branches: list[Branch] = []
    async for branch in service.list_branches(repo_id):
        branches.append(branch)

    assert branches, "fixture must seed at least one branch for the first repo"
    for branch in branches:
        assert isinstance(branch, Branch)
        assert branch.name
        assert branch.provider


@pytest.mark.asyncio
async def test_get_authenticated_clone_url_returns_https_url(git_service_factory):
    service = git_service_factory()
    items, _ = await service.list_repositories()
    repo_id = items[0].id

    url = await service.get_authenticated_clone_url(repo_id)

    assert isinstance(url, str)
    assert url.startswith("https://")
    # The repo id (or some derivation of it) should appear in the URL so
    # callers can sanity-check they got the right URL back.
    # Adapters may URL-encode segments; checking the bare last segment is
    # a permissive but meaningful sanity check.
    last_segment = repo_id.rsplit("/", 1)[-1]
    assert last_segment in url


@pytest.mark.asyncio
async def test_raw_returns_underlying_client_object(git_service_factory):
    service = git_service_factory()
    raw = await service.raw()
    assert raw is not None


@pytest.mark.asyncio
async def test_provider_field_is_non_empty_string(git_service_factory):
    service = git_service_factory()
    assert isinstance(service.provider, str)
    assert service.provider
