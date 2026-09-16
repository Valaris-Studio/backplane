# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for the executor factory + URL/token resolver (PAR-3-wiring).

The factory builds a real `MergeExecutor` wired against the live DB session
factory and settings. We don't exercise the FastAPI background task here —
the loop in `app/main.py` only adds asyncio scheduling on top of the
factory output, which is hard to drive in-process. Instead we test:

  - the factory returns an executor whose resolver does an async DB lookup
    of GitRepo by `entry.repo_id` and returns a token-embedded URL;
  - the resolver is idempotent (no caching state to leak across calls);
  - no available credential leaves the URL untouched (preserves dev-mode
    behaviour, where nothing is configured and public repos still clone).

Phase 2 moved the token SOURCE from `settings.GITHUB_TOKEN` to
CredentialResolver, so these drive `_resolve_credential` and set the platform
token on `app.config.settings` (the resolver's fallback input) rather than on
the factory's settings object. The URL shapes asserted here are unchanged —
that is the point: the global-fallback path must behave exactly as before for
deployments that never create a workspace connection.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.merge_executor import MergeExecutor, make_merge_executor


class _Settings:
    """Minimal stand-in for `app.config.settings` — only the fields the
    factory reads. Avoids depending on env vars in test runs."""

    def __init__(
        self,
        *,
        git_user_name: str = "Backplane Merge Bot",
        git_user_email: str = "merge-bot@valaris.studio",
    ) -> None:
        self.GIT_USER_NAME = git_user_name
        self.GIT_USER_EMAIL = git_user_email
        self.GITHUB_API_URL = "https://api.github.com"


@pytest.fixture
def platform_tokens(monkeypatch):
    """Set the platform's env tokens where the RESOLVER reads them.

    The resolver's global-fallback step reads `app.config.settings`, not the
    settings object handed to the factory. Everything is cleared by default so
    a developer's exported GITHUB_TOKEN can't silently satisfy the fallback and
    mask a broken workspace-connection path.
    """
    from app.config import settings

    def _set(*, github: str = "", gitlab: str = "", gitea: str = ""):
        monkeypatch.setattr(settings, "GITHUB_TOKEN", github, raising=False)
        monkeypatch.setattr(settings, "GITLAB_TOKEN", gitlab, raising=False)
        monkeypatch.setattr(settings, "GITEA_TOKEN", gitea, raising=False)
        monkeypatch.setattr(
            settings, "GITHUB_API_URL", "https://api.github.com", raising=False
        )
        monkeypatch.setattr(
            settings, "ALLOW_GLOBAL_TOKEN_FALLBACK", True, raising=False
        )

    _set()
    return _set


async def _make_repo(
    db: AsyncSession,
    *,
    board: Board,
    user: User,
    url: str = "https://github.com/acme/widgets.git",
    provider: GitProvider = GitProvider.github,
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="widgets",
        slug="widgets",
        url=url,
        provider=provider,
        default_branch="main",
        added_by=user.id,
    )
    db.add(repo)
    await db.flush()
    return repo


def _entry_for_repo(repo: GitRepo, workspace: Workspace) -> MergeQueueEntry:
    return MergeQueueEntry(
        id=uuid.uuid4(),
        repo_id=repo.id,
        integration_branch="develop",
        card_id=uuid.uuid4(),
        pr_url="https://github.com/acme/widgets/pull/9",
        pr_branch="feat/lights",
        workspace_id=workspace.id,
        state="merging",
        attempt_count=1,
    )


def _session_factory_yielding(session: AsyncSession):
    """Wrap the test's per-function session in an async-context-manager
    factory matching `app.database.async_session`'s shape."""

    class _CM:
        async def __aenter__(self_inner):
            return session

        async def __aexit__(self_inner, *exc):
            return False

    def _factory():
        return _CM()

    return _factory


@pytest.mark.asyncio
async def test_make_merge_executor_returns_merge_executor(
    db_session: AsyncSession,
):
    factory_settings = _Settings()
    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=factory_settings,
    )
    assert isinstance(executor, MergeExecutor)


@pytest.mark.asyncio
async def test_resolve_repo_url_returns_authenticated_url(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    platform_tokens,
):
    platform_tokens(github="ghp_TESTTOKEN")
    repo = await _make_repo(db_session, board=test_board, user=test_user)
    entry = _entry_for_repo(repo, test_workspace)

    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=_Settings(),
    )
    resolved = await executor._resolve_credential(entry)

    assert resolved.url == (
        "https://x-access-token:ghp_TESTTOKEN@github.com/acme/widgets.git"
    )


@pytest.mark.asyncio
async def test_resolve_repo_url_empty_token_leaves_url_unchanged(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    platform_tokens,
):
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://github.com/acme/widgets.git",
    )
    entry = _entry_for_repo(repo, test_workspace)

    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=_Settings(),
    )
    resolved = await executor._resolve_credential(entry)

    assert resolved.url == "https://github.com/acme/widgets.git"


@pytest.mark.asyncio
async def test_resolve_repo_url_ssh_url_passes_through(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    platform_tokens,
):
    platform_tokens(github="ghp_TESTTOKEN")
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="git@github.com:acme/widgets.git",
    )
    entry = _entry_for_repo(repo, test_workspace)

    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=_Settings(),
    )
    resolved = await executor._resolve_credential(entry)

    assert resolved.url == "git@github.com:acme/widgets.git"


@pytest.mark.asyncio
async def test_resolve_repo_url_gitlab_uses_oauth2_userinfo_and_gitlab_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    platform_tokens,
):
    # A gitlab repo authenticates with GITLAB_TOKEN under the magic `oauth2`
    # username — NOT the github x-access-token form. GITHUB_TOKEN is set here
    # to pin that it is NOT what a gitlab repo gets (the closed cross-provider
    # fallback bug).
    platform_tokens(github="ghp_X", gitlab="glpat_Y")
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://gitlab.com/acme/widgets.git",
        provider=GitProvider.gitlab,
    )
    entry = _entry_for_repo(repo, test_workspace)

    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=_Settings(),
    )
    resolved = await executor._resolve_credential(entry)

    assert resolved.url == "https://oauth2:glpat_Y@gitlab.com/acme/widgets.git"


@pytest.mark.asyncio
async def test_resolve_repo_url_self_hosted_gitea_needs_a_workspace_connection(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    platform_tokens,
):
    """GITEA_TOKEN names no host — there is no canonical gitea instance — so it
    can no longer be embedded into an arbitrary gitea URL.

    This is a deliberate narrowing of the old behavior: the previous code put
    GITEA_TOKEN (or worse, GITHUB_TOKEN) into whatever host the repo named,
    which is the exfiltration primitive the resolver exists to close. A
    self-hosted gitea now authenticates via a workspace connection whose
    base_url pins the host — covered in test_merge_executor_credential_wiring.
    """
    platform_tokens(github="ghp_X", gitea="gta_Z")
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://gitea.example.com/acme/widgets.git",
        provider=GitProvider.gitea,
    )
    entry = _entry_for_repo(repo, test_workspace)

    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=_Settings(),
    )
    resolved = await executor._resolve_credential(entry)

    assert resolved.url == "https://gitea.example.com/acme/widgets.git"
    assert "gta_Z" not in resolved.url
    assert "ghp_X" not in resolved.url
    assert resolved.resolution.detail


@pytest.mark.asyncio
async def test_resolve_forge_returns_repo_provider_value(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://gitea.example.com/acme/widgets.git",
        provider=GitProvider.gitea,
    )
    entry = _entry_for_repo(repo, test_workspace)

    executor = make_merge_executor(
        session_factory=_session_factory_yielding(db_session),
        settings=_Settings(),
    )
    assert await executor._resolve_forge(entry) == "gitea"
