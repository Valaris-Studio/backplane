# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Done-gate, reconciler, and scheduler read PR state with the REPO's
credential (Phase 2).

All three used `settings.GITHUB_TOKEN`. On a deployment serving a workspace
whose forge the platform has no account on, that token reads nothing — and
each seam's soft-pass then hides the reason behind a generic "no token"
warning that names neither the repo nor the fix.

The behavior these tests pin, per seam:
  - the repo's resolved credential is what reaches GitHubClient;
  - no credential preserves today's soft-pass (never a hard failure), but the
    warning carries the resolution reason + detail;
  - a 401/403 while using a workspace connection marks it unhealthy, and a
    success clears it.
"""

from __future__ import annotations

import logging
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
from app.services.git.repo_credentials import (
    RepoCredentialLookup,
    credential_for_repo,
)

GITHUB_PR = "https://github.com/acme/widgets/pull/42"


@pytest.fixture(autouse=True)
def _no_ambient_env_tokens(monkeypatch):
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


async def _make_connection(
    db: AsyncSession,
    workspace: Workspace,
    user: User,
    *,
    account_login: str = "acme-bot",
    token: str = "ghp_workspace",
    last_error: str | None = None,
) -> GitConnection:
    connection = GitConnection(
        workspace_id=workspace.id,
        provider=GitProvider.github,
        account_login=account_login,
        account_type="user",
        encrypted_access_token=_vault().encrypt(token),
        scopes=["repo"],
        connected_by=user.id,
        last_error=last_error,
    )
    db.add(connection)
    await db.flush()
    return connection


async def _make_repo(
    db: AsyncSession,
    *,
    board: Board,
    user: User,
    url: str = "https://github.com/acme/widgets.git",
    connection_id: uuid.UUID | None = None,
) -> GitRepo:
    repo = GitRepo(
        board_id=board.id,
        workspace_id=board.workspace_id,
        name="widgets",
        slug="widgets",
        url=url,
        provider=GitProvider.github,
        default_branch="main",
        added_by=user.id,
        connection_id=connection_id,
    )
    db.add(repo)
    await db.flush()
    return repo


# --- credential_for_repo: the shared lookup all three seams call -------------


@pytest.mark.asyncio
async def test_credential_for_repo_returns_the_bound_connections_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    connection = await _make_connection(db_session, test_workspace, test_user)
    repo = await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )

    lookup = await credential_for_repo(db_session, repo)

    assert lookup.token == "ghp_workspace"
    assert lookup.connection_id == connection.id


@pytest.mark.asyncio
async def test_credential_for_repo_falls_back_to_the_platform_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(db_session, board=test_board, user=test_user)

    lookup = await credential_for_repo(db_session, repo)

    assert lookup.token == "ghp_platform"
    assert lookup.connection_id is None


@pytest.mark.asyncio
async def test_credential_for_repo_without_a_credential_explains_why(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    """The reason+detail replace the old generic "GITHUB_TOKEN is unset"."""
    repo = await _make_repo(db_session, board=test_board, user=test_user)

    lookup = await credential_for_repo(db_session, repo)

    assert lookup.token is None
    assert lookup.reason == "no_connection"
    assert "no github connection" in lookup.detail


@pytest.mark.asyncio
async def test_credential_for_repo_by_board_finds_the_boards_repo(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    connection = await _make_connection(db_session, test_workspace, test_user)
    await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )

    lookup = await RepoCredentialLookup(db_session).for_board(test_board.id)

    assert lookup.token == "ghp_workspace"


@pytest.mark.asyncio
async def test_credential_for_board_without_a_repo_soft_passes(
    db_session: AsyncSession, test_board: Board
):
    """An ops/triage board has no repo; every seam must soft-pass rather than
    raise."""
    lookup = await RepoCredentialLookup(db_session).for_board(test_board.id)

    assert lookup.token is None
    assert lookup.detail


# --- Done-gate ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_done_gate_uses_the_repos_workspace_credential(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.services.kanban import card as card_module

    connection = await _make_connection(db_session, test_workspace, test_user)
    await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )

    tokens_seen: list[str] = []

    class _FakeClient:
        def __init__(self, token: str, base_url: str = ""):
            tokens_seen.append(token)

        async def get_pr_status(self, pr_url: str):
            from app.services.github_client import PRStatus

            return PRStatus(merged=True, mergeable=None, state="closed")

    monkeypatch.setattr(card_module, "GitHubClient", _FakeClient)

    service = card_module.CardService(db_session)
    await service._pr_status_for_board(test_board.id, GITHUB_PR)

    assert tokens_seen == ["ghp_workspace"]


@pytest.mark.asyncio
async def test_done_gate_without_a_credential_warns_with_the_reason(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    caplog,
):
    """Soft-pass is preserved (no exception), but the operator learns WHY."""
    from app.services.kanban import card as card_module

    await _make_repo(db_session, board=test_board, user=test_user)

    service = card_module.CardService(db_session)
    with caplog.at_level(logging.WARNING):
        status = await service._pr_status_for_board(test_board.id, GITHUB_PR)

    assert status is None
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "no github connection" in messages


# --- reconciler --------------------------------------------------------------


@pytest.mark.asyncio
async def test_reconciler_uses_the_repos_workspace_credential(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.services.kanban import reconciler as reconciler_module

    connection = await _make_connection(db_session, test_workspace, test_user)
    await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )

    tokens_seen: list[str] = []

    class _FakeClient:
        def __init__(self, token: str, base_url: str = ""):
            tokens_seen.append(token)

        async def get_pr_status(self, pr_url: str):
            from app.services.github_client import PRStatus

            return PRStatus(merged=True, mergeable=None, state="closed")

    monkeypatch.setattr(reconciler_module, "GitHubClient", _FakeClient)

    status = await reconciler_module.board_scoped_pr_status(
        db_session, test_board.id, GITHUB_PR
    )

    assert status.merged is True
    assert tokens_seen == ["ghp_workspace"]


@pytest.mark.asyncio
async def test_reconciler_without_a_credential_skips_the_card_with_a_reason(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    caplog,
):
    """Never move a card on anything short of a positive merged=True — with no
    credential there is no positive, so the card waits and the reason is
    logged."""
    from app.services.kanban import reconciler as reconciler_module

    await _make_repo(db_session, board=test_board, user=test_user)

    with caplog.at_level(logging.WARNING):
        status = await reconciler_module.board_scoped_pr_status(
            db_session, test_board.id, GITHUB_PR
        )

    assert status is None
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "no github connection" in messages


# --- scheduler ---------------------------------------------------------------


@pytest.mark.asyncio
async def test_scheduler_precondition_uses_the_boards_repo_credential(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    from app.services.scheduling import preconditions as precond_module

    connection = await _make_connection(db_session, test_workspace, test_user)
    await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )

    tokens_seen: list[str] = []

    class _FakeClient:
        def __init__(self, token: str, base_url: str = ""):
            tokens_seen.append(token)

        async def list_open_prs(self, repo_url: str):
            return []

    monkeypatch.setattr(precond_module, "GitHubClient", _FakeClient)

    factory = precond_module.board_github_client_factory(db_session, test_board.id)
    client = await factory()

    assert client is not None
    assert tokens_seen == ["ghp_workspace"]


@pytest.mark.asyncio
async def test_scheduler_precondition_without_a_credential_soft_passes(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    caplog,
):
    """Hard-failing here would deadlock every workspace that configures no
    credential — the gate stays OFF, loudly."""
    from app.services.scheduling import preconditions as precond_module

    await _make_repo(db_session, board=test_board, user=test_user)

    with caplog.at_level(logging.WARNING):
        factory = precond_module.board_github_client_factory(
            db_session, test_board.id
        )
        client = await factory()

    assert client is None
    messages = " ".join(r.getMessage() for r in caplog.records)
    assert "no github connection" in messages


# --- health bookkeeping across the three read-only seams ---------------------


@pytest.mark.asyncio
async def test_a_401_while_using_a_connection_marks_it_unhealthy(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    from app.exceptions import BadGatewayError

    connection = await _make_connection(db_session, test_workspace, test_user)
    repo = await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )
    lookup = await credential_for_repo(db_session, repo)

    await lookup.record_failure(db_session, "GitHub returned 401 Bad credentials")

    refreshed = await db_session.get(GitConnection, connection.id)
    assert "401" in refreshed.last_error


@pytest.mark.asyncio
async def test_a_success_clears_the_connections_recorded_failure(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    connection = await _make_connection(
        db_session, test_workspace, test_user, last_error="401 Bad credentials"
    )
    repo = await _make_repo(
        db_session, board=test_board, user=test_user, connection_id=connection.id
    )
    lookup = await credential_for_repo(db_session, repo)

    await lookup.record_success(db_session)

    refreshed = await db_session.get(GitConnection, connection.id)
    assert refreshed.last_error is None


@pytest.mark.asyncio
async def test_health_bookkeeping_is_a_noop_for_the_platform_token(
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
    monkeypatch,
):
    """No connection row to mark — and no exception either."""
    from app.config import settings

    monkeypatch.setattr(settings, "GITHUB_TOKEN", "ghp_platform", raising=False)
    repo = await _make_repo(db_session, board=test_board, user=test_user)
    lookup = await credential_for_repo(db_session, repo)

    await lookup.record_failure(db_session, "401")
    await lookup.record_success(db_session)
