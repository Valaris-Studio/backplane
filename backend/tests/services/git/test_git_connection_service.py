# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Service-layer tests for GitConnectionService."""

from __future__ import annotations

import os
from datetime import datetime, timezone

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace
from app.services.git.git_connection import GitConnectionService


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


@pytest.mark.asyncio
async def test_create_or_update_connection_inserts_when_new(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    result, created = await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_first",
        scopes=["repo"],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )

    assert created is True
    assert result.account_login == "octocat"
    assert result.scopes == ["repo"]
    # OAuth-minted connections keep auth_kind 'oauth' by default.
    assert result.auth_kind == "oauth"
    rows = (await db_session.execute(__select_all_conn())).scalars().all()
    assert len(list(rows)) == 1


@pytest.mark.asyncio
async def test_create_or_update_connection_updates_when_exists(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    first, first_created = await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_first",
        scopes=["repo"],
        connected_by=test_user.id,
    )
    second, second_created = await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="organization",
        access_token="ghp_second",
        scopes=["repo", "workflow"],
        expires_at=datetime(2027, 1, 1, tzinfo=timezone.utc),
        connected_by=test_user.id,
    )

    assert first_created is True
    assert second_created is False
    assert first.id == second.id
    assert second.account_type == "organization"
    assert second.scopes == ["repo", "workflow"]
    rows = list((await db_session.execute(__select_all_conn())).scalars().all())
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_oauth_reconnect_over_pat_row_replaces_stale_health(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """An OAuth reconnect genuinely re-mints the credential.

    The row's auth_kind flips back to 'oauth' and the PAT-era health stamps go
    with it — carrying a stale last_error onto a freshly exchanged token would
    show operators a failure that no longer exists.
    """
    service = GitConnectionService(db_session, vault=_vault())
    await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_pat",
        scopes=["repo"],
        connected_by=test_user.id,
        auth_kind="pat",
        last_verified_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        last_error="an old failure",
    )

    updated, created = await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="gho_oauth",
        scopes=["repo"],
        connected_by=test_user.id,
    )

    assert created is False
    assert updated.auth_kind == "oauth"
    assert updated.last_error is None


@pytest.mark.asyncio
async def test_create_or_update_connection_re_encrypts_token_on_update(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_first",
        scopes=["repo"],
        connected_by=test_user.id,
    )
    await service.create_or_update_connection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_rotated",
        scopes=["repo"],
        connected_by=test_user.id,
    )

    row = (await db_session.execute(__select_all_conn())).scalar_one()
    decrypted = _vault().decrypt(row.encrypted_access_token)
    assert decrypted == "ghp_rotated"


def __select_all_conn():
    from sqlalchemy import select

    return select(GitConnection)
