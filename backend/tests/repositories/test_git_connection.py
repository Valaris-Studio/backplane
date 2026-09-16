# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Repository-level tests for GitConnection.

Pure data-access — encryption + authorization live in the service layer.
Sprint 1 of the integrations layer (app/integrations/git/).
"""

from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.git.git_connection import GitConnectionRepository


async def _other_workspace(db: AsyncSession, owner: User) -> Workspace:
    other = Workspace(name="Other", slug="other", created_by=owner.id)
    db.add(other)
    await db.flush()
    db.add(
        WorkspaceMember(
            workspace_id=other.id, user_id=owner.id, role=WorkspaceRole.owner
        )
    )
    await db.flush()
    return other


@pytest.mark.asyncio
async def test_create_git_connection_persists_encrypted_tokens(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = GitConnectionRepository(db_session)
    connection = await repo.create(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        encrypted_access_token=b"\x01\x02\x03encrypted",
        encrypted_refresh_token=b"\x04\x05refresh",
        scopes=["repo", "read:user"],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )

    assert connection.id is not None
    assert connection.encrypted_access_token == b"\x01\x02\x03encrypted"
    assert connection.encrypted_refresh_token == b"\x04\x05refresh"
    assert connection.scopes == ["repo", "read:user"]
    assert connection.account_login == "octocat"


@pytest.mark.asyncio
async def test_list_by_workspace_returns_only_connections_for_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = GitConnectionRepository(db_session)
    other = await _other_workspace(db_session, test_user)

    mine = await repo.create(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        encrypted_access_token=b"a",
        encrypted_refresh_token=None,
        scopes=[],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )
    await repo.create(
        workspace_id=other.id,
        provider=GitProvider.github,
        account_login="other-octocat",
        account_type="user",
        encrypted_access_token=b"b",
        encrypted_refresh_token=None,
        scopes=[],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )

    mine_only = await repo.list_by_workspace(test_workspace.id)
    ids = [c.id for c in mine_only]
    assert mine.id in ids
    assert len(mine_only) == 1


@pytest.mark.asyncio
async def test_unique_constraint_on_workspace_provider_account_login(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = GitConnectionRepository(db_session)
    await repo.create(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        encrypted_access_token=b"a",
        encrypted_refresh_token=None,
        scopes=[],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )

    with pytest.raises(IntegrityError):
        await repo.create(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            encrypted_access_token=b"b",
            encrypted_refresh_token=None,
            scopes=[],
            expires_at=None,
            base_url=None,
            connected_by=test_user.id,
        )


@pytest.mark.asyncio
async def test_get_by_id_returns_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = GitConnectionRepository(db_session)
    created = await repo.create(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        encrypted_access_token=b"a",
        encrypted_refresh_token=None,
        scopes=[],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )

    fetched = await repo.get_by_id(created.id)
    assert fetched is not None
    assert fetched.id == created.id


@pytest.mark.asyncio
async def test_delete_removes_row(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    repo = GitConnectionRepository(db_session)
    created = await repo.create(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        encrypted_access_token=b"a",
        encrypted_refresh_token=None,
        scopes=[],
        expires_at=None,
        base_url=None,
        connected_by=test_user.id,
    )

    await repo.delete(created)

    assert await repo.get_by_id(created.id) is None


_ = GitConnection  # silence "imported but unused" — kept for fixture clarity.
