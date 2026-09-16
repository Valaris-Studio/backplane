# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Persistence of the scope verdict a probe produces.

`verify_connection` has always COMPUTED per-duty checks and thrown them away
after rendering one accordion. An operator who pastes an under-scoped GitHub
fine-grained PAT therefore sees the same green "Working" chip as one that can
actually push and merge — the chip reads `last_error`/`last_verified_at`, and
an identity-only success writes neither a failure nor a scope verdict.

`scopes_confirmed` is that verdict, persisted: true when every required scope
was disclosed AND present, false when the forge disclosed nothing or a
required scope is missing, null when nothing has ever assessed the row.
"""

from __future__ import annotations

import os

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.integrations.git.vault import FernetTokenVault
from app.models.git.git_connection import GitConnection
from app.models.git.git_repo import GitProvider
from app.models.user import User
from app.models.workspace import Workspace
from app.schemas.git.git_connection import GitConnectionPatCreate
from app.services.git.forge_probe import (
    ForgeProbe,
    ProbeIdentity,
    ProbeUnauthorized,
)
from app.services.git.git_connection import GitConnectionService


def _vault() -> FernetTokenVault:
    return FernetTokenVault(os.environ["INTEGRATIONS_TOKEN_KEY"].encode())


class ScriptedProbe(ForgeProbe):
    """Returns a fixed identity, or raises a fixed error."""

    def __init__(self, outcome):
        self.outcome = outcome

    async def probe(
        self, *, provider: GitProvider, token: str, base_url: str | None
    ) -> ProbeIdentity:
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return self.outcome


def _service(db: AsyncSession) -> GitConnectionService:
    return GitConnectionService(db, vault=_vault())


@pytest_asyncio.fixture
async def stored_connection(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
) -> GitConnection:
    connection = GitConnection(
        workspace_id=test_workspace.id,
        provider=GitProvider.github,
        account_login="acme-bot",
        account_type="user",
        encrypted_access_token=_vault().encrypt("ghp_secret"),
        scopes=["repo"],
        connected_by=test_user.id,
    )
    db_session.add(connection)
    await db_session.flush()
    return connection


async def _reload(db: AsyncSession, connection_id) -> GitConnection:
    db.expire_all()
    return (
        await db.execute(select(GitConnection).where(GitConnection.id == connection_id))
    ).scalar_one()


@pytest.mark.asyncio
async def test_legacy_row_has_no_scope_verdict(stored_connection: GitConnection):
    """Null is a third answer, not a default-to-false."""
    assert stored_connection.scopes_confirmed is None


@pytest.mark.asyncio
async def test_verify_marks_undisclosed_scopes_unconfirmed(
    db_session: AsyncSession, test_workspace: Workspace, stored_connection: GitConnection
):
    """A GitHub fine-grained PAT discloses nothing — that is not a pass."""
    probe = ScriptedProbe(
        ProbeIdentity(account_login="acme-bot", account_type="user", scopes=[])
    )

    result = await _service(db_session).verify_connection(
        connection_id=stored_connection.id,
        workspace_id=test_workspace.id,
        probe=probe,
    )

    assert result.connection.scopes_confirmed is False
    row = await _reload(db_session, stored_connection.id)
    assert row.scopes_confirmed is False
    assert row.last_error is None


@pytest.mark.asyncio
async def test_verify_confirms_classic_token_with_required_scope(
    db_session: AsyncSession, test_workspace: Workspace, stored_connection: GitConnection
):
    probe = ScriptedProbe(
        ProbeIdentity(
            account_login="acme-bot", account_type="user", scopes=["repo", "workflow"]
        )
    )

    result = await _service(db_session).verify_connection(
        connection_id=stored_connection.id,
        workspace_id=test_workspace.id,
        probe=probe,
    )

    assert result.connection.scopes_confirmed is True
    row = await _reload(db_session, stored_connection.id)
    assert row.scopes_confirmed is True


@pytest.mark.asyncio
async def test_verify_rejects_token_missing_a_required_scope(
    db_session: AsyncSession, test_workspace: Workspace, stored_connection: GitConnection
):
    """Disclosed-but-insufficient is as unconfirmed as undisclosed."""
    probe = ScriptedProbe(
        ProbeIdentity(
            account_login="acme-bot", account_type="user", scopes=["read:user"]
        )
    )

    result = await _service(db_session).verify_connection(
        connection_id=stored_connection.id,
        workspace_id=test_workspace.id,
        probe=probe,
    )

    assert result.connection.scopes_confirmed is False


@pytest.mark.asyncio
async def test_failed_probe_leaves_the_previous_verdict_untouched(
    db_session: AsyncSession, test_workspace: Workspace, stored_connection: GitConnection
):
    """A 401 says nothing about scopes — overwriting the verdict would lie."""
    stored_connection.scopes_confirmed = True
    await db_session.flush()

    result = await _service(db_session).verify_connection(
        connection_id=stored_connection.id,
        workspace_id=test_workspace.id,
        probe=ScriptedProbe(ProbeUnauthorized("token rejected")),
    )

    assert result.connection.last_error is not None
    assert result.connection.scopes_confirmed is True
    row = await _reload(db_session, stored_connection.id)
    assert row.scopes_confirmed is True


@pytest.mark.asyncio
async def test_pat_add_records_the_verdict_without_a_verify_click(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    """The misleading chip appears the moment the token is pasted, so the
    verdict has to land on the add path too — not only on explicit verify."""
    probe = ScriptedProbe(
        ProbeIdentity(account_login="fine-grained-bot", account_type="user", scopes=[])
    )

    connection, _ = await _service(db_session).create_pat_connection(
        workspace_id=test_workspace.id,
        data=GitConnectionPatCreate(
            provider=GitProvider.github, token="github_pat_x", base_url=None
        ),
        actor_id=test_user.id,
        probe=probe,
    )

    assert connection.scopes_confirmed is False
    row = await _reload(db_session, connection.id)
    assert row.scopes_confirmed is False


@pytest.mark.asyncio
async def test_pat_add_confirms_a_fully_scoped_classic_token(
    db_session: AsyncSession, test_workspace: Workspace, test_user: User
):
    probe = ScriptedProbe(
        ProbeIdentity(
            account_login="classic-bot", account_type="user", scopes=["repo"]
        )
    )

    connection, _ = await _service(db_session).create_pat_connection(
        workspace_id=test_workspace.id,
        data=GitConnectionPatCreate(
            provider=GitProvider.github, token="ghp_x", base_url=None
        ),
        actor_id=test_user.id,
        probe=probe,
    )

    assert connection.scopes_confirmed is True
