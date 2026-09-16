# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Service-level tests for GitConnectionService.

Sprint 1 of the integrations layer (app/integrations/git/). Covers
encryption-at-rest, token retrieval, and cross-workspace authorization.
"""

from __future__ import annotations

import pytest
from cryptography.fernet import Fernet
from sqlalchemy.ext.asyncio import AsyncSession

from app.exceptions import ResourceNotFoundError
from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.git.git_connection import GitConnectionRepository
from app.schemas.git.git_connection import GitConnectionCreateInternal
from app.services.git.git_connection import GitConnectionService


def _vault() -> FernetTokenVault:
    return FernetTokenVault(Fernet.generate_key())


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
async def test_create_connection_returns_read_schema_without_tokens(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    payload = GitConnectionCreateInternal(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_secret_xyz",
        refresh_token="ghr_refresh",
        scopes=["repo"],
        connected_by=test_user.id,
    )

    read = await service.create_connection(payload)

    assert read.account_login == "octocat"
    # Read schema NEVER contains tokens.
    assert not hasattr(read, "access_token")
    assert not hasattr(read, "encrypted_access_token")


@pytest.mark.asyncio
async def test_create_connection_persists_ciphertext_not_plaintext(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    vault = _vault()
    service = GitConnectionService(db_session, vault=vault)
    payload = GitConnectionCreateInternal(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="octocat",
        account_type="user",
        access_token="ghp_secret_xyz",
        connected_by=test_user.id,
    )

    read = await service.create_connection(payload)

    raw = await GitConnectionRepository(db_session).get_by_id(read.id)
    assert raw is not None
    assert raw.encrypted_access_token != b"ghp_secret_xyz"
    assert vault.decrypt(raw.encrypted_access_token) == "ghp_secret_xyz"


@pytest.mark.asyncio
async def test_get_decrypted_access_token_returns_plaintext(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    read = await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            access_token="ghp_secret_xyz",
            connected_by=test_user.id,
        )
    )

    plaintext = await service.get_decrypted_access_token(
        read.id, test_workspace.id
    )

    assert plaintext == "ghp_secret_xyz"


@pytest.mark.asyncio
async def test_get_decrypted_access_token_raises_for_cross_workspace_access(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    read = await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            access_token="ghp_secret_xyz",
            connected_by=test_user.id,
        )
    )
    other = await _other_workspace(db_session, test_user)

    with pytest.raises(ResourceNotFoundError):
        await service.get_decrypted_access_token(read.id, other.id)


@pytest.mark.asyncio
async def test_list_connections_returns_only_workspace_connections(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    other = await _other_workspace(db_session, test_user)

    mine = await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            access_token="a",
            connected_by=test_user.id,
        )
    )
    await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=other.id,
            provider=GitProvider.github,
            account_login="other",
            account_type="user",
            access_token="b",
            connected_by=test_user.id,
        )
    )

    listed = await service.list_connections(test_workspace.id)
    assert [c.id for c in listed] == [mine.id]


@pytest.mark.asyncio
async def test_delete_connection_removes_row(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    read = await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            access_token="ghp_secret_xyz",
            connected_by=test_user.id,
        )
    )

    await service.delete_connection(read.id, test_workspace.id)

    assert await service.list_connections(test_workspace.id) == []


@pytest.mark.asyncio
async def test_delete_connection_is_noop_for_cross_workspace(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """Deleting another workspace's connection neither succeeds nor 404s loudly.

    Delete is idempotent (agents retry, and "already gone" is a success), which
    means an out-of-workspace id must return the SAME answer as a nonexistent
    one — distinguishing them would turn the endpoint into an existence oracle
    for ids the caller cannot see. The row is left untouched.
    """
    service = GitConnectionService(db_session, vault=_vault())
    read = await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            access_token="ghp_secret_xyz",
            connected_by=test_user.id,
        )
    )
    other = await _other_workspace(db_session, test_user)

    await service.delete_connection(read.id, other.id)

    still_there = await service.list_connections(test_workspace.id)
    assert [c.id for c in still_there] == [read.id]


@pytest.mark.asyncio
async def test_delete_connection_is_idempotent(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    service = GitConnectionService(db_session, vault=_vault())
    read = await service.create_connection(
        GitConnectionCreateInternal(
            workspace_id=test_workspace.id,
            provider=GitProvider.github,
            account_login="octocat",
            account_type="user",
            access_token="ghp_secret_xyz",
            connected_by=test_user.id,
        )
    )

    await service.delete_connection(read.id, test_workspace.id)
    await service.delete_connection(read.id, test_workspace.id)

    assert await service.list_connections(test_workspace.id) == []
