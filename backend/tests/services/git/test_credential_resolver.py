# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""CredentialResolver decision table.

The resolver is the single seam every consumer (merge executor, done-gate, PR
sync, runner handoff) goes through to turn a GitRepo into a usable forge token.
Its security contract: a token is NEVER returned for a repo whose host the
token wasn't issued for — that is what stops a workspace-scoped PAT from being
embedded into an attacker-chosen clone URL.
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider, GitRepo
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace
from app.services.git.credential_resolver import (
    CredentialResolver,
    ResolutionReason,
)


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


@pytest.fixture(autouse=True)
def _no_ambient_env_tokens(monkeypatch):
    """Default every test to "no global fallback available".

    Tests that exercise the fallback opt back in explicitly; without this a
    developer's exported GITHUB_TOKEN would silently satisfy chain step 3 and
    mask a broken step 1/2.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "", raising=False)
    monkeypatch.setattr(settings, "GITLAB_TOKEN", "", raising=False)
    monkeypatch.setattr(settings, "GITEA_TOKEN", "", raising=False)
    monkeypatch.setattr(settings, "GITHUB_API_URL", "https://api.github.com", raising=False)
    monkeypatch.setattr(settings, "ALLOW_GLOBAL_TOKEN_FALLBACK", True, raising=False)


async def _make_connection(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    provider: GitProvider = GitProvider.github,
    account_login: str = "acme-bot",
    token: str = "ghp_secret",
    base_url: str | None = None,
    scopes: list[str] | None = None,
) -> GitConnection:
    conn = GitConnection(
        workspace_id=workspace.id,
        provider=provider,
        account_login=account_login,
        account_type="organization",
        encrypted_access_token=_vault().encrypt(token),
        scopes=scopes if scopes is not None else ["repo"],
        base_url=base_url,
        auth_kind="pat",
        connected_by=user.id,
    )
    db.add(conn)
    await db.flush()
    return conn


async def _make_repo(
    db: AsyncSession,
    workspace: Workspace,
    board: Board,
    user: User,
    *,
    url: str = "https://github.com/acme/widgets.git",
    provider: GitProvider = GitProvider.github,
    connection_id: uuid.UUID | None = None,
    slug: str = "widgets",
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=workspace.id,
        name="widgets",
        slug=slug,
        url=url,
        provider=provider,
        default_branch="main",
        description="",
        added_by=user.id,
        connection_id=connection_id,
    )
    db.add(repo)
    await db.flush()
    return repo


# --- chain step 1: the repo's explicitly bound connection ---


async def test_resolve_prefers_repo_bound_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    bound = await _make_connection(
        db_session, test_workspace, test_user, account_login="bound-bot", token="ghp_bound"
    )
    await _make_connection(
        db_session, test_workspace, test_user, account_login="other-bot", token="ghp_other"
    )
    repo = await _make_repo(
        db_session, test_workspace, test_board, test_user, connection_id=bound.id
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.token == "ghp_bound"
    assert result.credential.username == "x-access-token"
    assert result.credential.host == "github.com"
    assert result.credential.connection_id == bound.id
    assert result.credential.source == "workspace connection bound-bot"


async def test_resolve_bound_connection_wins_over_ambiguity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """Two connections would be ambiguous — an explicit binding resolves it."""
    bound = await _make_connection(
        db_session, test_workspace, test_user, account_login="a-bot", token="ghp_a"
    )
    await _make_connection(
        db_session, test_workspace, test_user, account_login="b-bot", token="ghp_b"
    )
    repo = await _make_repo(
        db_session, test_workspace, test_board, test_user, connection_id=bound.id
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.token == "ghp_a"


async def test_resolve_bound_connection_host_mismatch_returns_no_credential(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """The security fix: a github.com token must never reach git.example.com."""
    bound = await _make_connection(
        db_session, test_workspace, test_user, account_login="acme-bot", token="ghp_secret"
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://git.example.com/acme/widgets.git",
        connection_id=bound.id,
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.host_mismatch
    assert "git.example.com" in result.detail
    assert "acme-bot" in result.detail
    assert "github.com" in result.detail


async def test_resolve_bound_connection_from_other_workspace_is_ignored(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    other_ws = Workspace(name="Other", slug="other-ws", created_by=test_user.id)
    db_session.add(other_ws)
    await db_session.flush()
    foreign = await _make_connection(
        db_session, other_ws, test_user, account_login="foreign-bot", token="ghp_foreign"
    )
    repo = await _make_repo(
        db_session, test_workspace, test_board, test_user, connection_id=foreign.id
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.no_connection


# --- chain step 2: sole workspace connection for the provider ---


async def test_resolve_falls_back_to_sole_workspace_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session, test_workspace, test_user, account_login="only-bot", token="ghp_only"
    )
    repo = await _make_repo(db_session, test_workspace, test_board, test_user)

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.token == "ghp_only"
    assert result.credential.source == "workspace connection only-bot"


async def test_resolve_ignores_connections_for_a_different_provider(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session,
        test_workspace,
        test_user,
        provider=GitProvider.gitlab,
        account_login="gl-bot",
        token="glpat_x",
        base_url="https://gitlab.com",
    )
    repo = await _make_repo(db_session, test_workspace, test_board, test_user)

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.no_connection


async def test_resolve_multiple_unbound_connections_is_ambiguous(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session, test_workspace, test_user, account_login="a-bot", token="ghp_a"
    )
    await _make_connection(
        db_session, test_workspace, test_user, account_login="b-bot", token="ghp_b"
    )
    repo = await _make_repo(db_session, test_workspace, test_board, test_user)

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.ambiguous_connections
    assert "a-bot" in result.detail and "b-bot" in result.detail


async def test_resolve_sole_connection_host_mismatch_returns_no_credential(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session, test_workspace, test_user, account_login="acme-bot", token="ghp_secret"
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://ghe.internal.corp/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.host_mismatch


async def test_resolve_self_hosted_connection_matches_its_base_url_host(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session,
        test_workspace,
        test_user,
        account_login="ghe-bot",
        token="ghp_enterprise",
        base_url="https://ghe.internal.corp/api/v3",
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://ghe.internal.corp/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.token == "ghp_enterprise"
    assert result.credential.host == "ghe.internal.corp"


# --- gitea: no provider default host, base_url is mandatory ---


async def test_resolve_gitea_connection_with_base_url_matches(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session,
        test_workspace,
        test_user,
        provider=GitProvider.gitea,
        account_login="gitea-bot",
        token="gta_token",
        base_url="https://git.acme.dev",
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitea,
        url="https://git.acme.dev/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.token == "gta_token"
    assert result.credential.username == "oauth2"
    assert result.credential.host == "git.acme.dev"


async def test_resolve_gitea_connection_without_base_url_has_no_host(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    conn = await _make_connection(
        db_session,
        test_workspace,
        test_user,
        provider=GitProvider.gitea,
        account_login="gitea-bot",
        token="gta_token",
        base_url=None,
    )
    assert conn.base_url is None
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitea,
        url="https://git.acme.dev/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.host_mismatch
    assert "base_url" in result.detail


async def test_resolve_gitea_repo_never_uses_global_fallback(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """GITEA_TOKEN has no determinable host, so it can never be host-matched."""
    from app.config import settings

    monkeypatch.setattr(settings, "GITEA_TOKEN", "gta_global", raising=False)
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitea,
        url="https://git.acme.dev/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.provider_has_no_fallback
    assert "base_url" in result.detail


# --- chain step 3: global env token fallback ---


async def test_resolve_falls_back_to_global_github_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(db_session, test_workspace, test_board, test_user)

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.token == "ghp_platform"
    assert result.credential.source == "platform token"
    assert result.credential.connection_id is None
    assert result.credential.host == "github.com"


async def test_resolve_global_github_token_host_derives_from_api_url(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """A GHE deployment sets GITHUB_API_URL; the token belongs to that host."""
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    monkeypatch.setattr(
        settings, "GITHUB_API_URL", "https://ghe.internal.corp/api/v3", raising=False
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://ghe.internal.corp/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.host == "ghe.internal.corp"


async def test_resolve_global_github_token_not_used_for_foreign_host(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://evil.example.com/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.host_mismatch


async def test_resolve_global_gitlab_token_only_matches_gitlab_com(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.config import settings

    monkeypatch.setattr(settings, "GITLAB_TOKEN", "glpat_global", raising=False)
    hosted = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitlab,
        url="https://gitlab.com/acme/widgets.git",
        slug="hosted",
    )
    self_hosted = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitlab,
        url="https://gitlab.acme.dev/acme/widgets.git",
        slug="self-hosted",
    )

    resolver = CredentialResolver(db_session)
    ok = await resolver.resolve(hosted)
    denied = await resolver.resolve(self_hosted)

    assert ok.credential is not None
    assert ok.credential.token == "glpat_global"
    assert ok.credential.username == "oauth2"
    assert denied.credential is None
    assert denied.reason == ResolutionReason.host_mismatch


async def test_resolve_gitlab_repo_does_not_borrow_github_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """The old merge_executor fell back to GITHUB_TOKEN for any provider."""
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitlab,
        url="https://gitlab.com/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.provider_has_no_fallback


async def test_resolve_fallback_disabled_by_kill_switch(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    monkeypatch.setattr(settings, "ALLOW_GLOBAL_TOKEN_FALLBACK", False, raising=False)
    repo = await _make_repo(db_session, test_workspace, test_board, test_user)

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.fallback_disabled
    assert "workspace" in result.detail.lower()


async def test_resolve_no_connection_and_no_global_token(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    repo = await _make_repo(db_session, test_workspace, test_board, test_user)

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.no_connection
    assert "github.com" in result.detail


# --- host normalization ---


async def test_resolve_host_comparison_is_case_insensitive(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session,
        test_workspace,
        test_user,
        account_login="ghe-bot",
        base_url="https://GHE.Internal.Corp",
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://ghe.INTERNAL.corp/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None


async def test_resolve_strips_www_prefix_on_both_sides(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session,
        test_workspace,
        test_user,
        account_login="ghe-bot",
        base_url="https://www.ghe.internal.corp",
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://ghe.internal.corp/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None


async def test_resolve_port_is_part_of_host_identity(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """host:8080 and host:9090 are different origins — don't hand one the other's token."""
    await _make_connection(
        db_session,
        test_workspace,
        test_user,
        provider=GitProvider.gitea,
        account_login="gitea-bot",
        base_url="https://git.acme.dev:8080",
    )
    matching = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitea,
        url="https://git.acme.dev:8080/acme/widgets.git",
        slug="matching",
    )
    other_port = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        provider=GitProvider.gitea,
        url="https://git.acme.dev:9090/acme/widgets.git",
        slug="other-port",
    )

    resolver = CredentialResolver(db_session)
    assert (await resolver.resolve(matching)).credential is not None
    denied = await resolver.resolve(other_port)
    assert denied.credential is None
    assert denied.reason == ResolutionReason.host_mismatch


async def test_resolve_scp_style_repo_url_host_is_matched(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session, test_workspace, test_user, account_login="acme-bot", token="ghp_secret"
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="git@github.com:acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is not None
    assert result.credential.host == "github.com"


async def test_resolve_repo_url_with_embedded_credentials_matches_real_host(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    """`https://user@evil.com/...` must resolve host to evil.com, not user."""
    await _make_connection(
        db_session, test_workspace, test_user, account_login="acme-bot", token="ghp_secret"
    )
    repo = await _make_repo(
        db_session,
        test_workspace,
        test_board,
        test_user,
        url="https://github.com@evil.example.com/acme/widgets.git",
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.host_mismatch


async def test_resolve_unparseable_repo_url_returns_no_credential(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board, test_user: User
):
    await _make_connection(
        db_session, test_workspace, test_user, account_login="acme-bot", token="ghp_secret"
    )
    repo = await _make_repo(
        db_session, test_workspace, test_board, test_user, url="not-a-url"
    )

    result = await CredentialResolver(db_session).resolve(repo)

    assert result.credential is None
    assert result.reason == ResolutionReason.unparseable_repo_url
