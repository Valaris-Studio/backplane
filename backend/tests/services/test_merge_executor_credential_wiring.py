# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`make_merge_executor`'s credential resolution against a real DB (Phase 2).

The unit tests in test_merge_executor_credentials.py inject a fake resolver;
these drive the production one, so they are what proves the executor actually
reads git_connections rather than settings.GITHUB_TOKEN.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.git.vault import FernetTokenVault
from app.models.agents.merge_queue import MergeQueueEntry
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.merge_executor import make_merge_executor


class _Settings:
    """Only the fields the factory reads."""

    def __init__(
        self,
        *,
        github_token: str = "",
        gitlab_token: str = "",
        gitea_token: str = "",
    ) -> None:
        self.GITHUB_TOKEN = github_token
        self.GITLAB_TOKEN = gitlab_token
        self.GITEA_TOKEN = gitea_token
        self.GITHUB_API_URL = "https://api.github.com"
        self.ALLOW_GLOBAL_TOKEN_FALLBACK = True
        self.GIT_USER_NAME = "Backplane Merge Bot"
        self.GIT_USER_EMAIL = "merge-bot@valaris.studio"


@pytest.fixture(autouse=True)
def _no_ambient_env_tokens(monkeypatch):
    """The resolver reads app.config.settings for the global fallback, not the
    factory's settings object. A developer's exported GITHUB_TOKEN would
    otherwise satisfy chain step 3 and mask a broken step 1/2."""
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "", raising=False)
    monkeypatch.setattr(settings, "GITLAB_TOKEN", "", raising=False)
    monkeypatch.setattr(settings, "GITEA_TOKEN", "", raising=False)
    monkeypatch.setattr(
        settings, "GITHUB_API_URL", "https://api.github.com", raising=False
    )
    monkeypatch.setattr(settings, "ALLOW_GLOBAL_TOKEN_FALLBACK", True, raising=False)


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


async def _make_repo(
    db: AsyncSession,
    *,
    board: Board,
    user: User,
    url: str = "https://github.com/acme/widgets.git",
    provider: GitProvider = GitProvider.github,
    connection_id: uuid.UUID | None = None,
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
        connection_id=connection_id,
    )
    db.add(repo)
    await db.flush()
    return repo


async def _make_connection(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    provider: GitProvider = GitProvider.github,
    account_login: str = "acme-bot",
    token: str = "ghp_workspace",
    base_url: str | None = None,
) -> GitConnection:
    connection = GitConnection(
        workspace_id=workspace.id,
        provider=provider,
        account_login=account_login,
        account_type="user",
        encrypted_access_token=_vault().encrypt(token),
        scopes=["repo"],
        base_url=base_url,
        connected_by=user.id,
    )
    db.add(connection)
    await db.flush()
    return connection


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
    class _CM:
        async def __aenter__(self_inner):
            return session

        async def __aexit__(self_inner, *exc):
            return False

    return lambda: _CM()


def _executor(db: AsyncSession, settings: _Settings):
    return make_merge_executor(
        session_factory=_session_factory_yielding(db), settings=settings
    )


@pytest.mark.asyncio
async def test_bound_connection_token_is_embedded_in_the_clone_url(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    connection = await _make_connection(db_session, test_workspace, test_user)
    repo = await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(db_session, _Settings())._resolve_credential(entry)

    assert resolved.url == (
        "https://x-access-token:ghp_workspace@github.com/acme/widgets.git"
    )
    assert resolved.credential.connection_id == connection.id
    assert resolved.credential.source == "workspace connection acme-bot"


@pytest.mark.asyncio
async def test_workspace_connection_beats_the_platform_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """The whole point of the program: a tenant's own credential wins over the
    platform's, even when both could serve the host."""
    from app.config import settings as app_settings

    monkeypatch.setattr(app_settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    await _make_connection(db_session, test_workspace, test_user)
    repo = await _make_repo(db_session, board=test_board, user=test_user)
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(
        db_session, _Settings(github_token="ghp_platform")
    )._resolve_credential(entry)

    assert "ghp_workspace" in resolved.url
    assert "ghp_platform" not in resolved.url


@pytest.mark.asyncio
async def test_platform_token_used_when_workspace_has_no_connection(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """Single-token deployments (the common case today) keep working."""
    from app.config import settings as app_settings

    monkeypatch.setattr(app_settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(db_session, board=test_board, user=test_user)
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(
        db_session, _Settings(github_token="ghp_platform")
    )._resolve_credential(entry)

    assert resolved.url == (
        "https://x-access-token:ghp_platform@github.com/acme/widgets.git"
    )
    assert resolved.credential.source == "platform token"
    assert resolved.credential.connection_id is None


@pytest.mark.asyncio
async def test_no_credential_leaves_the_url_unauthenticated(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    repo = await _make_repo(db_session, board=test_board, user=test_user)
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(db_session, _Settings())._resolve_credential(entry)

    assert resolved.url == "https://github.com/acme/widgets.git"
    assert resolved.credential is None
    assert resolved.resolution.detail


@pytest.mark.asyncio
async def test_github_token_is_never_handed_to_a_gitlab_repo(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """The closed bug: `_token_for_provider` fell back to GITHUB_TOKEN for
    every non-github provider, embedding a GitHub PAT into a gitlab.com clone
    URL."""
    from app.config import settings as app_settings

    monkeypatch.setattr(app_settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://gitlab.com/acme/widgets.git",
        provider=GitProvider.gitlab,
    )
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(
        db_session, _Settings(github_token="ghp_platform")
    )._resolve_credential(entry)

    assert "ghp_platform" not in resolved.url
    assert resolved.url == "https://gitlab.com/acme/widgets.git"


@pytest.mark.asyncio
async def test_gitlab_repo_uses_oauth2_userinfo_with_its_own_connection(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    connection = await _make_connection(
        db_session,
        test_workspace,
        test_user,
        provider=GitProvider.gitlab,
        account_login="acme-gl",
        token="glpat_Y",
    )
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://gitlab.com/acme/widgets.git",
        provider=GitProvider.gitlab,
        connection_id=connection.id,
    )
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(db_session, _Settings())._resolve_credential(entry)

    assert resolved.url == "https://oauth2:glpat_Y@gitlab.com/acme/widgets.git"


@pytest.mark.asyncio
async def test_self_hosted_gitea_repo_uses_its_workspace_connection(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """A gitea install the platform has no account on: the workspace's own
    connection is the ONLY way this repo can ever merge."""
    connection = await _make_connection(
        db_session,
        test_workspace,
        test_user,
        provider=GitProvider.gitea,
        account_login="acme-gitea",
        token="gta_Z",
        base_url="https://git.acme.dev",
    )
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="https://git.acme.dev/acme/widgets.git",
        provider=GitProvider.gitea,
        connection_id=connection.id,
    )
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(db_session, _Settings())._resolve_credential(entry)

    assert resolved.url == "https://oauth2:gta_Z@git.acme.dev/acme/widgets.git"


@pytest.mark.asyncio
async def test_ssh_repo_url_passes_through_unchanged(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """SSH auth uses the runner's key, not the platform token."""
    connection = await _make_connection(db_session, test_workspace, test_user)
    repo = await _make_repo(
        db_session,
        board=test_board,
        user=test_user,
        url="git@github.com:acme/widgets.git",
        connection_id=connection.id,
    )
    entry = _entry_for_repo(repo, test_workspace)

    resolved = await _executor(db_session, _Settings())._resolve_credential(entry)

    assert resolved.url == "git@github.com:acme/widgets.git"


@pytest.mark.asyncio
async def test_ci_check_uses_the_resolved_credential_not_the_global_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    test_card,
    monkeypatch,
):
    """The CI gate reads the PR's checks — with the platform token it reads a
    repo the platform may not be able to see at all, which fails CLOSED and
    wedges the queue for a tenant whose own token would have worked."""
    connection = await _make_connection(db_session, test_workspace, test_user)
    repo = await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )
    entry = _entry_for_repo(repo, test_workspace)
    entry.card_id = test_card.id

    tokens_seen: list[str] = []

    class _FakeClient:
        def __init__(self, token: str, base_url: str = ""):
            tokens_seen.append(token)

        async def get_pr_ci_state(self, pr_url: str) -> str:
            return "green"

    monkeypatch.setattr("app.services.github_client.GitHubClient", _FakeClient)

    executor = _executor(db_session, _Settings(github_token="ghp_platform"))
    assert await executor._check_ci(entry) == "green"
    assert tokens_seen == ["ghp_workspace"]
