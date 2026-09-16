# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""In-memory GitService implementation for tests + early-stage development.

LAYER: integrations (provider-agnostic). This lives in app/ rather than tests/
because it's part of the public testing surface — adapters in unrelated tests
inject it as a stub. The real adapters (GitHubAdapter, etc.) live alongside
this file; the contract test suite at tests/integrations/git/test_contract.py
runs against every implementation including this one.
"""

from __future__ import annotations

from typing import AsyncIterator

from app.integrations.git.exceptions import GitAuthError, GitNotFoundError
from app.integrations.git.models import Branch, Repository, User as GitUser


class FakeGitService:
    provider = "fake"

    def __init__(
        self,
        *,
        user: GitUser,
        repositories: list[Repository],
        branches_by_repo: dict[str, list[Branch]] | None = None,
        clone_url_template: str = "https://fake.example/{repo_id}.git",
        not_found_repo_ids: set[str] | None = None,
        auth_error: bool = False,
    ) -> None:
        self._user = user
        self._repositories = list(repositories)
        self._branches_by_repo = dict(branches_by_repo or {})
        self._clone_url_template = clone_url_template
        self._not_found_repo_ids = set(not_found_repo_ids or set())
        self._auth_error = auth_error
        self._repos_by_id = {repo.id: repo for repo in self._repositories}

    async def get_authenticated_user(self) -> GitUser:
        if self._auth_error:
            raise GitAuthError("invalid credentials")
        return self._user

    async def list_repositories(
        self, *, cursor: str | None = None
    ) -> tuple[list[Repository], str | None]:
        # v1: single page, no real cursor logic. Adapters that paginate
        # for real should still return (items, next_cursor) tuples.
        return list(self._repositories), None

    async def get_repository(self, repo_id: str) -> Repository:
        if repo_id in self._not_found_repo_ids:
            raise GitNotFoundError(f"repository {repo_id!r} not found")
        repo = self._repos_by_id.get(repo_id)
        if repo is None:
            raise GitNotFoundError(f"repository {repo_id!r} not found")
        return repo

    async def list_branches(self, repo_id: str) -> AsyncIterator[Branch]:
        if (
            repo_id in self._not_found_repo_ids
            or repo_id not in self._repos_by_id
        ):
            raise GitNotFoundError(f"repository {repo_id!r} not found")
        for branch in self._branches_by_repo.get(repo_id, []):
            yield branch

    async def get_authenticated_clone_url(self, repo_id: str) -> str:
        return self._clone_url_template.format(repo_id=repo_id)

    async def raw(self) -> object:
        # The fake IS its own underlying client — there's nothing else to
        # hand back. Real adapters return their SDK client (githubkit
        # `GitHub`, python-gitlab `Gitlab`, etc.).
        return self
