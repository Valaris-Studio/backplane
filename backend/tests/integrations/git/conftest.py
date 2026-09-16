# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Registration fixture for the GitService contract test suite.

Every adapter implementation (FakeGitService today; GitHubAdapter,
GitLabAdapter, BitbucketAdapter tomorrow) registers itself here as a
`(name, factory)` tuple. The contract suite at `test_contract.py`
parametrizes over this list, so a new adapter joins the suite by appending
one entry — no test changes required.

Factory contract (every adapter MUST honor it so the same tests can drive
every implementation):

    factory(
        *,
        user: GitUser | None = None,           # canned authed user
        repositories: list[Repository] | None = None,
        branches_by_repo: dict[str, list[Branch]] | None = None,
        not_found_repo_ids: set[str] | None = None,
        auth_error: bool = False,
    ) -> GitService

Real adapters back these knobs with VCR-style cassettes (e.g., the
"auth_error" path replays a recorded 401 response). The fake backs them
with in-memory state. Either way, the contract suite stays
implementation-agnostic.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable, Iterable

import httpx
import pytest

from app.integrations.git.adapters.github import GitHubAdapter
from app.integrations.git.models import Branch, Repository, User as GitUser
from app.integrations.git.service import GitService
from app.integrations.git.testing import FakeGitService


GitServiceFactory = Callable[..., GitService]


@dataclass(frozen=True)
class RegisteredImplementation:
    name: str
    factory: GitServiceFactory


def _default_user() -> GitUser:
    return GitUser(
        provider="fake",
        id="u-1",
        username="octocat",
        email="octocat@example.com",
        avatar_url=None,
    )


def _default_repositories() -> list[Repository]:
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return [
        Repository(
            provider="fake",
            id="acme/widgets",
            full_name="acme/widgets",
            default_branch="main",
            private=False,
            clone_url_https="https://fake.example/acme/widgets.git",
            updated_at=now,
        ),
        Repository(
            provider="fake",
            id="acme/sprockets",
            full_name="acme/sprockets",
            default_branch="trunk",
            private=True,
            clone_url_https="https://fake.example/acme/sprockets.git",
            updated_at=now,
        ),
    ]


def _default_branches() -> dict[str, list[Branch]]:
    return {
        "acme/widgets": [
            Branch(provider="fake", name="main", sha="aaaa1111"),
            Branch(provider="fake", name="develop", sha="bbbb2222"),
        ],
        "acme/sprockets": [
            Branch(provider="fake", name="trunk", sha="cccc3333"),
        ],
    }


def _fake_factory(
    *,
    user: GitUser | None = None,
    repositories: list[Repository] | None = None,
    branches_by_repo: dict[str, list[Branch]] | None = None,
    not_found_repo_ids: set[str] | None = None,
    auth_error: bool = False,
) -> GitService:
    return FakeGitService(
        user=user or _default_user(),
        repositories=repositories if repositories is not None else _default_repositories(),
        branches_by_repo=(
            branches_by_repo if branches_by_repo is not None else _default_branches()
        ),
        not_found_repo_ids=not_found_repo_ids or set(),
        auth_error=auth_error,
    )


# GitHub factory uses an httpx MockTransport instead of VCR cassettes — keeps
# the contract suite hermetic without adding a recording dependency. VCR
# becomes the right tool when we start caring about full-fidelity replay
# (header echo, content-type quirks); for the Sprint-2 read-only surface,
# a hand-rolled mock keeps the loop fast.
def _github_factory(
    *,
    user: GitUser | None = None,
    repositories: list[Repository] | None = None,
    branches_by_repo: dict[str, list[Branch]] | None = None,
    not_found_repo_ids: set[str] | None = None,
    auth_error: bool = False,
) -> GitService:
    fixture_user = user or _default_user()
    fixture_repos = (
        repositories if repositories is not None else _default_repositories()
    )
    fixture_branches = (
        branches_by_repo if branches_by_repo is not None else _default_branches()
    )
    not_found = not_found_repo_ids or set()
    transport = httpx.MockTransport(
        _build_github_handler(
            user=fixture_user,
            repositories=fixture_repos,
            branches_by_repo=fixture_branches,
            not_found_repo_ids=not_found,
            auth_error=auth_error,
        )
    )
    return GitHubAdapter(access_token="fixture-token", async_transport=transport)


def _build_github_handler(
    *,
    user: GitUser,
    repositories: list[Repository],
    branches_by_repo: dict[str, list[Branch]],
    not_found_repo_ids: set[str],
    auth_error: bool,
):
    def _user_payload() -> dict:
        return {
            "login": user.username,
            "id": int(user.id) if user.id.isdigit() else 1,
            "type": "User",
            "avatar_url": user.avatar_url or "",
            "email": user.email,
        }

    def _repo_payload(repo: Repository) -> dict:
        return {
            "id": abs(hash(repo.full_name)) % (10**9),
            "full_name": repo.full_name,
            "name": repo.full_name.split("/", 1)[-1],
            "private": repo.private,
            "default_branch": repo.default_branch,
            "clone_url": repo.clone_url_https,
            "updated_at": (
                repo.updated_at.replace(tzinfo=None).isoformat() + "Z"
            ),
            "owner": {
                "login": repo.full_name.split("/", 1)[0],
                "type": "Organization",
            },
        }

    def _json(status: int, body, headers: dict[str, str] | None = None) -> httpx.Response:
        return httpx.Response(
            status,
            content=json.dumps(body).encode(),
            headers={"content-type": "application/json", **(headers or {})},
        )

    def handler(request: httpx.Request) -> httpx.Response:
        if auth_error:
            return _json(401, {"message": "Bad credentials"})
        path = request.url.path
        if path == "/user":
            return _json(200, _user_payload())
        if path == "/user/repos":
            return _json(200, [_repo_payload(r) for r in repositories])
        if path.startswith("/repos/"):
            # /repos/{owner}/{name} or /repos/{owner}/{name}/branches
            tail = path[len("/repos/") :]
            parts = tail.split("/")
            repo_id = "/".join(parts[:2])
            rest = parts[2:]
            if repo_id in not_found_repo_ids:
                return _json(404, {"message": "Not Found"})
            repo = next(
                (r for r in repositories if r.full_name == repo_id), None
            )
            if repo is None:
                return _json(404, {"message": "Not Found"})
            if not rest:
                return _json(200, _repo_payload(repo))
            if rest == ["branches"]:
                return _json(
                    200,
                    [
                        {"name": b.name, "commit": {"sha": b.sha}}
                        for b in branches_by_repo.get(repo_id, [])
                    ],
                )
        return _json(404, {"message": "Unhandled mock path: " + path})

    return handler


REGISTERED_IMPLEMENTATIONS: tuple[RegisteredImplementation, ...] = (
    RegisteredImplementation(name="fake", factory=_fake_factory),
    RegisteredImplementation(name="github", factory=_github_factory),
    # Sprint 4: GitLabAdapter. Sprint 5: Bitbucket.
)


def _ids(impls: Iterable[RegisteredImplementation]) -> list[str]:
    return [impl.name for impl in impls]


@pytest.fixture(params=REGISTERED_IMPLEMENTATIONS, ids=_ids(REGISTERED_IMPLEMENTATIONS))
def git_service_factory(request) -> GitServiceFactory:
    """Yields a per-implementation factory.

    Tests that want default canned data call `git_service_factory()`. Tests
    that want to drive specific behavior (auth_error=True, custom repos)
    pass kwargs.
    """
    return request.param.factory
